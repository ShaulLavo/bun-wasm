//! Prepares packages while resolution waits on registry metadata.
//!
//! A cold resolution spends most of its time waiting for metadata, and the install phase
//! after it spends most of its time extracting archives. When an install starts without
//! `node_modules`, the archives of packages resolution has placed are fetched and extracted
//! during those waits, into staging that this install owns under the temporary directory,
//! outside the project. Nothing touches the project until the install phase, which runs
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
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::{
    Package, installed_source,
    io::{self, Downloads, Registry},
    trace,
};

/// Names of staging directories, followed by the project's hash and the install's own suffix.
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

/// The temporary directory, as an absolute path (`std::env::temp_dir` is missing on WASI).
fn temp_dir(cwd: &Path) -> PathBuf {
    let temp = std::env::var_os("TMPDIR").map_or_else(|| PathBuf::from("/tmp"), PathBuf::from);
    cwd.join(temp)
}

/// Staging names for the project in `cwd`: a hash of its path, so reaping stays within it.
fn project_prefix(cwd: &Path) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(cwd.to_string_lossy().as_bytes());
    format!(
        "{STAGING}{:x}-",
        u64::from_be_bytes(hash[..8].try_into().unwrap())
    )
}

/// Creates this install's staging after removing what an interrupted install of the same
/// project left. Two installs of one project at once are unsupported anyway: each replaces
/// the other's node_modules.
fn create_staging(cwd: &Path) -> Option<PathBuf> {
    let temp = temp_dir(cwd);
    let prefix = project_prefix(cwd);
    if let Ok(entries) = fs::read_dir(&temp) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).ok()?;
    let root = temp.join(format!("{prefix}{:x}", u128::from_le_bytes(random)));
    fs::create_dir_all(&root).ok()?;
    Some(root)
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
    /// `None` when no staging can be made.
    pub fn start(cwd: &Path, refresh: bool) -> Option<(Self, StagingGuard)> {
        let root = create_staging(cwd)?;
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
