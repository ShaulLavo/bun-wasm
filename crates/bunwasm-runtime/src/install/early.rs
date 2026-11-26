//! Prepares packages while resolution waits on registry metadata.
//!
//! A cold resolution spends most of its time waiting for metadata, and the install phase
//! after it spends most of its time extracting archives. When an install starts without
//! `node_modules`, the archives of packages resolution has placed are fetched and extracted
//! during those waits, into staging that this install owns under the temporary directory,
//! outside the project. Each install creates its own uniquely named staging and removes only
//! that one; an install never deletes staging it did not create. When the temporary
//! directory is the project or inside it, or can't be resolved, there is no early work.
//! Staging that a killed install left is cleared by whoever knows nothing is running: the
//! browser hosts at boot, and on the native launcher the system's temporary-file cleaner.
//! Nothing touches the project until the install phase, which runs
//! after the final graph and lockfile exist and publishes each staged package by rename, in
//! install order; where a rename cannot move it, the package is extracted again from its
//! archive, which staging keeps for that and for later packages with the same archive.
//!
//! Every fetch made here is the fetch for that package: its outcome, failure included, is
//! handed to the install phase, which never fetches again to replace it. When a fetch
//! succeeded but staging did not finish, the install phase installs from those same bytes,
//! so archive errors appear exactly as without early work.
use std::{
    collections::{BTreeSet, VecDeque},
    ffi::{OsStr, OsString},
    fs, io as stdio,
    path::{Component, Path, PathBuf},
};

use serde_json::Value;

use super::{
    Package, installed_source,
    io::{self, Downloads, Registry},
    trace,
};

/// Names of staging directories, followed by the install's own random suffix. The browser
/// hosts clear these at boot (`web/src/install-staging.ts`).
pub const STAGING: &str = "bun-wasm-early-";
/// Archives requested ahead while metadata is still loading. Metadata decides when
/// resolution ends, so archives take a small share of the connection.
const EARLY_TARBALLS: usize = 8;
/// Larger packages wait for the install phase: a paused extraction resumes by inflating
/// its archive again from the start, so huge archives would repeat too much of that.
const EARLY_FILES: u64 = 2048;
const EARLY_BYTES: u64 = 32 * 1024 * 1024;
/// After this many pauses an extraction runs to its end, bounding the inflation it repeats.
const MAX_PAUSES: u32 = 8;
/// Archive memory that prepared packages may hold. Past it, the rest wait for the install
/// phase.
const PREPARED_BYTES: usize = 64 * 1024 * 1024;

/// Removes this install's staging when the install ends, however it ends.
pub struct StagingGuard(PathBuf);

impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Symlinks followed while resolving one path before giving up on a loop.
const MAX_LINKS: u32 = 40;

/// Where this install may stage: the temporary directory (`tmpdir`, or `/tmp`), resolved
/// against `cwd`, unless it is the project in `cwd` or inside it or can't be resolved.
pub(super) fn staging_parent(cwd: &Path, tmpdir: Option<&OsStr>) -> Option<PathBuf> {
    let project = resolve(cwd)?;
    let temp = resolve(&project.join(tmpdir.unwrap_or(OsStr::new("/tmp"))))?;
    (!temp.starts_with(&project)).then_some(temp)
}

/// `path` with `.`, `..` and symlinks resolved, as `realpath` would (`fs::canonicalize` is
/// unsupported on WASI). A missing tail is kept as written. `None` when `path` is relative,
/// a link can't be read, or links loop.
fn resolve(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut queue: VecDeque<OsString> = parts(path).into();
    let mut resolved = PathBuf::from("/");
    let mut links = 0;
    while let Some(part) = queue.pop_front() {
        if part == ".." {
            resolved.pop();
            continue;
        }
        let candidate = resolved.join(&part);
        let Some(target) = link_target(&candidate)? else {
            resolved = candidate;
            continue;
        };
        links += 1;
        if links > MAX_LINKS {
            return None;
        }
        if target.is_absolute() {
            resolved = PathBuf::from("/");
        }
        for piece in parts(&target).into_iter().rev() {
            queue.push_front(piece);
        }
    }
    Some(resolved)
}

/// The names and `..` steps of `path`.
fn parts(path: &Path) -> Vec<OsString> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_owned()),
            Component::ParentDir => Some("..".into()),
            _ => None,
        })
        .collect()
}

/// The target of the symlink at `path`: `Some(None)` when it is not a symlink or is missing,
/// `None` when it can't be read.
fn link_target(path: &Path) -> Option<Option<PathBuf>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::read_link(path).ok().map(Some),
        Ok(_) => Some(None),
        Err(error) if error.kind() == stdio::ErrorKind::NotFound => Some(None),
        Err(_) => None,
    }
}

/// Creates a staging directory under `parent` that this install alone owns: an exclusive
/// create under a fresh random name.
fn create_staging(parent: &Path) -> Option<PathBuf> {
    fs::create_dir_all(parent).ok()?;
    for _ in 0..4 {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).ok()?;
        let root = parent.join(format!("{STAGING}{:032x}", u128::from_le_bytes(random)));
        match fs::create_dir(&root) {
            Ok(()) => return Some(root),
            Err(error) if error.kind() == stdio::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

/// What early work did for one package, keyed by its source record.
pub enum Outcome {
    /// Extracted and validated in `staging`; the install phase publishes it by rename. The
    /// archive goes to the install's archive reuse, or is extracted again if the rename fails.
    Staged {
        staging: PathBuf,
        bins: Value,
        bytes: Vec<u8>,
    },
    /// The archive arrived but staging did not finish; install from these bytes.
    Fetched(Vec<u8>),
    /// The fetch failed with this error.
    Failed(String),
}

pub struct Early {
    pub downloads: Downloads,
    root: PathBuf,
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
    /// Archive bytes the outcomes hold.
    held: usize,
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
    /// Early work for an install in `cwd`, with the guard that removes its staging, or
    /// `None` when there is to be none (see [`staging_parent`]).
    pub fn start(cwd: &Path, refresh: bool) -> Option<(Self, StagingGuard)> {
        Self::start_in(cwd, std::env::var_os("TMPDIR").as_deref(), refresh)
    }

    /// [`Early::start`] with the temporary directory `tmpdir` instead of `$TMPDIR`.
    pub(super) fn start_in(
        cwd: &Path,
        tmpdir: Option<&OsStr>,
        refresh: bool,
    ) -> Option<(Self, StagingGuard)> {
        let root = create_staging(&staging_parent(cwd, tmpdir)?)?;
        Some((Self::new(root.clone(), refresh), StagingGuard(root)))
    }

    fn new(root: PathBuf, refresh: bool) -> Self {
        Self {
            downloads: Downloads::new(EARLY_TARBALLS),
            root,
            refresh,
            active: BTreeSet::new(),
            queue: VecDeque::new(),
            urls: BTreeSet::new(),
            current: None,
            outcomes: Vec::new(),
            jobs: 0,
            held: 0,
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
        if self.current.is_none() && !self.begin(registry) {
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
    fn begin(&mut self, registry: &Registry) -> bool {
        if self.held >= PREPARED_BYTES {
            return false;
        }
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
        self.held += bytes.capacity();
        let staging = self.root.join(self.jobs.to_string());
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
        let outcome = Outcome::Staged {
            staging: job.staging,
            bins,
            bytes: job.bytes,
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
    /// This install's staging directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

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
