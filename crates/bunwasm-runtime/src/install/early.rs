//! Installs packages while resolution waits on registry metadata.
//!
//! A cold resolution spends most of its time waiting for metadata, and the install phase
//! after it spends most of its time extracting archives. When an install starts without
//! `node_modules`, packages that resolution has already placed are downloaded and extracted
//! during those waits. Placement never moves a package once it is added, so the result is
//! the same tree the install phase would have built; the install phase skips what is done
//! here, and `reconcile` removes anything that the final graph no longer contains.
//!
//! Only successes count. A package whose download or extraction fails here is left to the
//! install phase, which then reports or tolerates the failure exactly as it does today.
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::PathBuf,
};

use serde_json::Value;

use super::{
    Package, forget_installed_source, installed_source,
    io::{self, Downloads, Registry},
    trace,
};

/// Archives requested ahead while metadata is still loading. Metadata decides when
/// resolution ends, so archives take a small share of the connection.
const EARLY_TARBALLS: usize = 8;
/// Larger packages wait for the install phase, so one long extraction never holds up the
/// metadata requests that resolution issues next.
const EARLY_FILES: u64 = 256;

/// A package installed during resolution.
pub struct Done {
    /// The source record it was installed with.
    source: Vec<u8>,
    path: PathBuf,
    pub bins: Value,
}

pub struct Early {
    pub downloads: Downloads,
    refresh: bool,
    /// Keys whose packages the final graph is expected to keep: reachable from the root
    /// through packages compatible with this platform.
    active: BTreeSet<String>,
    queue: VecDeque<Package>,
    queued: BTreeSet<String>,
    pub done: BTreeMap<String, Done>,
}

impl Early {
    pub fn new(refresh: bool) -> Self {
        Self {
            downloads: Downloads::new(EARLY_TARBALLS),
            refresh,
            active: BTreeSet::new(),
            queue: VecDeque::new(),
            queued: BTreeSet::new(),
            done: BTreeMap::new(),
        }
    }

    /// Resolution placed `package` as a dependency of `parent` (`None`: the root).
    pub fn added(&mut self, package: &Package, parent: Option<&str>, registry: &Registry) {
        let parent_active = parent.is_none_or(|parent| self.active.contains(parent));
        if !parent_active
            || package.source_chain.is_some()
            || !super::resolve::compatible(&package.meta)
        {
            return;
        }
        let key = package.key();
        self.active.insert(key.clone());
        if package.local.is_some() || package.explicit_tarball || !small(&package.meta) {
            return;
        }
        self.queued.insert(key);
        self.queue.push_back(package.clone());
        self.prefetch(registry);
    }

    fn prefetch(&mut self, registry: &Registry) {
        for package in &self.queue {
            if self.downloads.is_full() {
                return;
            }
            self.downloads
                .prefetch(&package.tarball, true, self.refresh, registry);
        }
    }

    /// Installs one queued package whose archive has arrived. Returns whether it did any
    /// work. `metadata` keeps moving during the extraction.
    pub fn work(&mut self, metadata: &mut Downloads, registry: &Registry) -> bool {
        self.prefetch(registry);
        let Some(index) = self.next(registry) else {
            return false;
        };
        let package = self.queue.remove(index).unwrap();
        self.queued.remove(&package.key());
        self.install(&package, metadata, registry);
        self.prefetch(registry);
        true
    }

    /// The first queued package that can be installed now: its ancestors in the tree are
    /// installed here and its archive is ready. Packages whose ancestors will not be are
    /// dropped, so they wait for the install phase together with those ancestors.
    fn next(&mut self, registry: &Registry) -> Option<usize> {
        self.downloads.poll(registry);
        let mut index = 0;
        while index < self.queue.len() {
            let package = &self.queue[index];
            match self.ancestors(package) {
                Ancestors::Lost => {
                    let package = self.queue.remove(index).unwrap();
                    self.queued.remove(&package.key());
                    continue;
                }
                Ancestors::Done if self.downloads.ready(&package.tarball, true) => {
                    return Some(index);
                }
                Ancestors::Done | Ancestors::Waiting => index += 1,
            }
        }
        None
    }

    fn ancestors(&self, package: &Package) -> Ancestors {
        for level in 1..package.chain.len() {
            let key = package.chain[..level].join("/");
            if self.done.contains_key(&key) {
                continue;
            }
            if self.queued.contains(&key) {
                return Ancestors::Waiting;
            }
            return Ancestors::Lost;
        }
        Ancestors::Done
    }

    fn install(&mut self, package: &Package, metadata: &mut Downloads, registry: &Registry) {
        let Ok(bytes) = self
            .downloads
            .fetch(&package.tarball, true, self.refresh, registry)
        else {
            return;
        };
        let downloads = &mut self.downloads;
        let mut tick = || {
            downloads.tick(registry);
            metadata.tick(registry);
        };
        let result = trace::time("early-install", || {
            super::extract_package(package, &bytes, &mut tick, true)
        });
        let Ok(Some(bins)) = result else {
            return;
        };
        self.done.insert(
            package.key(),
            Done {
                source: installed_source(package),
                path: package.path(),
                bins,
            },
        );
    }

    /// Keeps the early installs that the final graph contains unchanged and removes the
    /// rest, along with anything installed inside them.
    pub fn reconcile(&mut self, packages: &BTreeMap<String, Package>) -> io::Result<()> {
        let mut removed: Vec<PathBuf> = Vec::new();
        let keys: Vec<String> = self.done.keys().cloned().collect();
        for key in keys {
            let done = &self.done[&key];
            let inside_removed = removed.iter().any(|path| done.path.starts_with(path));
            let kept = !inside_removed
                && packages
                    .get(&key)
                    .is_some_and(|package| installed_source(package) == done.source);
            if kept {
                continue;
            }
            let done = self.done.remove(&key).unwrap();
            if !inside_removed {
                remove(&done.path)?;
                removed.push(done.path);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
impl Early {
    pub fn move_to_front(&mut self, key: &str) {
        let index = self
            .queue
            .iter()
            .position(|package| package.key() == key)
            .unwrap();
        let package = self.queue.remove(index).unwrap();
        self.queue.push_front(package);
    }
}

enum Ancestors {
    Done,
    Waiting,
    Lost,
}

/// Whether the registry says the package is small enough to extract during resolution.
fn small(meta: &Value) -> bool {
    let dist = &meta["dist"];
    dist["fileCount"]
        .as_u64()
        .is_none_or(|count| count <= EARLY_FILES)
        && dist["unpackedSize"]
            .as_u64()
            .is_none_or(|size| size <= EARLY_BYTES)
}

const EARLY_BYTES: u64 = 4 * 1024 * 1024;

fn remove(path: &std::path::Path) -> io::Result<()> {
    forget_installed_source(path)?;
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}
