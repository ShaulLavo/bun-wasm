//! Prepares packages while resolution waits on registry metadata.
//!
//! A cold resolution spends most of its time waiting for metadata, and the install phase
//! after it spends most of its time extracting archives. When an install starts without
//! `node_modules`, the archives of packages resolution has placed are fetched and extracted
//! during those waits, into private staging at `STAGING` in the project root. Workspace
//! globs never match a dot directory, and nothing else that resolution reads refers to it.
//! Nothing touches `node_modules` until the install phase, which runs after the final graph
//! and lockfile exist and publishes each staged package by rename, in install order.
//!
//! Every fetch made here is the fetch for that package: its outcome, failure included, is
//! handed to the install phase, which never fetches again to replace it. When a fetch
//! succeeded but staging did not finish, the install phase installs from those same bytes,
//! so archive errors appear exactly as without early work.
use std::{
    collections::{BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::{
    Package, installed_source,
    io::{self, Downloads, Registry},
    trace,
};

/// Where early work stages packages, relative to the project root.
pub const STAGING: &str = ".bun-wasm-early";
/// Archives requested ahead while metadata is still loading. Metadata decides when
/// resolution ends, so archives take a small share of the connection.
const EARLY_TARBALLS: usize = 8;
/// Larger packages wait for the install phase: a paused extraction resumes by inflating
/// its archive again from the start, so huge archives would repeat too much of that.
const EARLY_FILES: u64 = 2048;
const EARLY_BYTES: u64 = 32 * 1024 * 1024;
/// After this many pauses an extraction runs to its end, bounding the inflation it repeats.
const MAX_PAUSES: u32 = 8;
/// Memory that staged packages' archives may keep for later packages with the same archive.
const KEPT_ARCHIVES: usize = 16 * 1024 * 1024;

/// Removes staging left by an interrupted run. Every install calls it before resolving.
pub fn discard_staging() {
    let _ = fs::remove_dir_all(STAGING);
}

/// Removes the staging directory when the install ends, however it ends.
pub struct StagingGuard;

impl Drop for StagingGuard {
    fn drop(&mut self) {
        discard_staging();
    }
}

/// What early work did for one package, keyed by its source record.
pub enum Outcome {
    /// Extracted and validated in `staging`; the install phase publishes it by rename.
    Staged {
        staging: PathBuf,
        bins: Value,
        /// The archive, kept while it fits, for later packages with the same archive.
        bytes: Option<Vec<u8>>,
    },
    /// The archive arrived but staging did not finish; install from these bytes.
    Fetched(Vec<u8>),
    /// The fetch failed with this error.
    Failed(String),
}

pub struct Early {
    pub downloads: Downloads,
    refresh: bool,
    /// Keys whose packages the final graph is expected to keep: reachable from the root
    /// through packages compatible with this platform.
    active: BTreeSet<String>,
    queue: VecDeque<Package>,
    /// Archive URLs queued or handled, so each is fetched here at most once.
    urls: BTreeSet<String>,
    current: Option<Job>,
    outcomes: Vec<(Vec<u8>, Outcome)>,
    jobs: usize,
    kept_bytes: usize,
}

/// The package being extracted, between the pauses that let resolution go on.
struct Job {
    package: Package,
    bytes: Vec<u8>,
    staging: PathBuf,
    extraction: io::Extraction,
    pauses: u32,
}

impl Early {
    pub fn new(refresh: bool) -> Self {
        Self {
            downloads: Downloads::new(EARLY_TARBALLS),
            refresh,
            active: BTreeSet::new(),
            queue: VecDeque::new(),
            urls: BTreeSet::new(),
            current: None,
            outcomes: Vec::new(),
            jobs: 0,
            kept_bytes: 0,
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
        self.active.insert(package.key());
        if package.local.is_some()
            || package.explicit_tarball
            || !small(&package.meta)
            || !self.urls.insert(package.tarball.clone())
        {
            return;
        }
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

    /// Works on one queued package whose archive has arrived. Returns whether it did any
    /// work. `metadata` keeps moving during the extraction.
    pub fn work(
        &mut self,
        metadata: &mut Downloads,
        registry: &Registry,
        arrived: &mut dyn FnMut() -> bool,
    ) -> bool {
        self.prefetch(registry);
        if self.current.is_none() && !self.start(registry) {
            return false;
        }
        trace::time("early-install", || self.resume(metadata, registry, arrived));
        self.prefetch(registry);
        true
    }

    /// Finishes the package in progress, so no extraction is left half done.
    pub fn settle(&mut self, registry: &Registry) {
        if self.current.is_none() {
            return;
        }
        let mut metadata = Downloads::new(0);
        trace::time("early-install", || {
            self.resume(&mut metadata, registry, &mut || false)
        });
    }

    /// Fetches the next ready package and stages it. Returns whether it did anything.
    fn start(&mut self, registry: &Registry) -> bool {
        let Some(index) = self.next(registry) else {
            return false;
        };
        let package = self.queue.remove(index).unwrap();
        let bytes = match self
            .downloads
            .fetch(&package.tarball, true, self.refresh, registry)
        {
            Ok(bytes) => bytes,
            Err(error) => {
                self.record(&package, Outcome::Failed(error));
                return true;
            }
        };
        self.jobs += 1;
        let staging = Path::new(STAGING).join(self.jobs.to_string());
        if super::stage_at(&package, &bytes, &staging).is_err() {
            let _ = fs::remove_dir_all(&staging);
            self.record(&package, Outcome::Fetched(bytes));
            return true;
        }
        self.current = Some(Job {
            extraction: io::Extraction::new(&staging),
            package,
            bytes,
            staging,
            pauses: 0,
        });
        true
    }

    /// Extracts the current package until resolution's awaited response arrives, and
    /// validates it once complete.
    fn resume(
        &mut self,
        metadata: &mut Downloads,
        registry: &Registry,
        arrived: &mut dyn FnMut() -> bool,
    ) {
        let Some(job) = self.current.as_mut() else {
            return;
        };
        let downloads = &mut self.downloads;
        let mut tick = || {
            downloads.tick(registry);
            metadata.tick(registry);
        };
        let mut never = || false;
        let pause: &mut dyn FnMut() -> bool = if job.pauses < MAX_PAUSES {
            &mut *arrived
        } else {
            &mut never
        };
        let ran = job
            .extraction
            .run(&job.bytes, &job.staging, &mut tick, pause);
        if matches!(ran, Ok(io::Extracted::Paused)) {
            job.pauses += 1;
            return;
        }
        let job = self.current.take().unwrap();
        let validated = ran.and_then(|_| super::validate_package(&job.staging, &job.package));
        let Ok(bins) = validated else {
            let _ = fs::remove_dir_all(&job.staging);
            self.record(&job.package, Outcome::Fetched(job.bytes));
            return;
        };
        let bytes = (self.kept_bytes + job.bytes.capacity() <= KEPT_ARCHIVES).then(|| {
            self.kept_bytes += job.bytes.capacity();
            job.bytes
        });
        let outcome = Outcome::Staged {
            staging: job.staging,
            bins,
            bytes,
        };
        self.record(&job.package, outcome);
    }

    fn record(&mut self, package: &Package, outcome: Outcome) {
        self.outcomes.push((installed_source(package), outcome));
    }

    /// The first queued package whose archive is ready.
    fn next(&mut self, registry: &Registry) -> Option<usize> {
        self.downloads.poll(registry);
        let refresh = self.refresh;
        let downloads = &mut self.downloads;
        self.queue
            .iter()
            .position(|package| downloads.ready(&package.tarball, true, refresh))
    }

    /// Takes the outcome prepared for `package`: the first one with its source record.
    pub fn claim(&mut self, package: &Package) -> Option<Outcome> {
        let source = installed_source(package);
        let index = self
            .outcomes
            .iter()
            .position(|(prepared, _)| *prepared == source)?;
        Some(self.outcomes.remove(index).1)
    }

    /// Whether an outcome is waiting for `package`, so its archive needs no prefetch.
    pub fn prepared(&self, package: &Package) -> bool {
        let source = installed_source(package);
        self.outcomes
            .iter()
            .any(|(prepared, _)| *prepared == source)
    }
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

#[cfg(test)]
impl Early {
    /// The kind of each prepared outcome, in the order they were prepared.
    pub fn kinds(&self) -> Vec<&'static str> {
        self.outcomes
            .iter()
            .map(|(_, outcome)| match outcome {
                Outcome::Staged { .. } => "staged",
                Outcome::Fetched(_) => "fetched",
                Outcome::Failed(_) => "failed",
            })
            .collect()
    }
}
