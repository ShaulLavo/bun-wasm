//! Original native adapter for Waffle's live executable registry contract.
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, File};
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{ACCES, IO, NOENT, NOTDIR};

pub const DEFAULT_PATHS: [&str; 2] = ["/bin/bun", "/bin/node"];
pub const ENGINE_PATHS: [(&str, [&str; 2]); 2] = [
    (
        "quickjs",
        ["/opt/bun/quickjs/bin/bun", "/opt/bun/quickjs/bin/node"],
    ),
    ("jsc", ["/opt/bun/jsc/bin/bun", "/opt/bun/jsc/bin/node"]),
];

/// A launcher-owned filesystem root containing real engine capability files.
/// Their implementation is a compiled Wasm module, not a native executable.
/// Removing a file revokes admission even while its module remains registered.
pub struct Executables {
    root: PathBuf,
    pub(super) entries: Mutex<BTreeMap<String, wasmtime::Module>>,
}

impl Executables {
    pub fn new(module: &wasmtime::Module) -> io::Result<Self> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = loop {
            let suffix = NEXT.fetch_add(1, Ordering::Relaxed);
            let candidate = std::env::temp_dir().join(format!(
                "bun-wasm-executables-{}-{suffix}",
                std::process::id()
            ));
            match fs::DirBuilder::new().mode(0o700).create(&candidate) {
                Ok(()) => break candidate,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        };
        let executables = Self {
            root,
            entries: Mutex::default(),
        };
        fs::create_dir_all(executables.root.join("opt/bun"))?;
        executables.register(&DEFAULT_PATHS, module)?;
        Ok(executables)
    }

    pub fn register(&self, paths: &[&str], module: &wasmtime::Module) -> io::Result<()> {
        for path in paths {
            let target = self.root.join(path.strip_prefix('/').unwrap());
            fs::create_dir_all(target.parent().unwrap())?;
            File::create(&target)?;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755))?;
            self.entries
                .lock()
                .unwrap()
                .insert(path.to_string(), module.clone());
        }
        Ok(())
    }

    pub fn mounts(&self) -> [(PathBuf, String); 2] {
        [
            (self.root.join("bin"), "/bin".into()),
            (self.root.join("opt/bun"), "/opt/bun".into()),
        ]
    }

    /// Walk the original guest path before looking up its normalized key: a
    /// missing or non-directory component cannot be erased by a later `..`.
    /// Absolute paths do not consult cwd (matching Waffle's registry).
    pub fn check(
        &self,
        executable: &str,
        cwd: &str,
        dirs: &[(PathBuf, String)],
    ) -> Result<(wasmtime::Module, String), i32> {
        let absolute = if executable.starts_with('/') {
            executable.to_string()
        } else {
            format!("{cwd}/{executable}")
        };
        let mut path = PathBuf::from("/");
        let mut remaining: VecDeque<String> =
            absolute.split('/').skip(1).map(str::to_owned).collect();
        let mut links = 0;
        while let Some(component) = remaining.pop_front() {
            // Inspect each original component, including those before `..` and trailing `/`.
            if !matches!(entry(&path, dirs)?, Entry::Directory) {
                return Err(NOTDIR);
            }
            match component.as_str() {
                ".." => {
                    path.pop();
                }
                "" | "." => {}
                part => path.push(part),
            }
            if let Entry::Symlink(target) = entry(&path, dirs)? {
                links += 1;
                if links > 40 {
                    return Err(-32);
                } // WASI ELOOP.
                path.pop();
                if target.is_absolute() {
                    path = PathBuf::from("/");
                }
                let target = target.to_str().ok_or(IO)?;
                for part in target.split('/').rev() {
                    remaining.push_front(part.to_owned());
                }
            }
        }
        if matches!(entry(&path, dirs)?, Entry::Directory) {
            return Err(ACCES);
        }
        // Match the pinned Waffle registry: a resolved alias cannot change its lexical key.
        // Do this only after walking every original component, so missing/.. still fails.
        let mut lexical = PathBuf::from("/");
        for component in absolute.split('/') {
            match component {
                ".." => {
                    lexical.pop();
                }
                "" | "." => {}
                part => lexical.push(part),
            }
        }
        if path != lexical {
            return Err(ACCES);
        }
        self.entries
            .lock()
            .unwrap()
            .get(path.to_str().unwrap_or_default())
            .cloned()
            .map(|module| (module, path.to_string_lossy().into_owned()))
            .ok_or(ACCES)
    }
}

impl Drop for Executables {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.root) {
            eprintln!("bun-wasm: removing {}: {error}", self.root.display());
        }
    }
}

enum Entry {
    Directory,
    File,
    Symlink(PathBuf),
}

fn entry(path: &Path, dirs: &[(PathBuf, String)]) -> Result<Entry, i32> {
    // A nested mount makes its ancestors directories in the guest namespace.
    if dirs
        .iter()
        .any(|(_, guest)| Path::new(guest) != path && Path::new(guest).starts_with(path))
    {
        return Ok(Entry::Directory);
    }
    let mapped = dirs
        .iter()
        .filter_map(|(host, guest)| {
            let guest = Path::new(guest);
            path.strip_prefix(guest)
                .ok()
                .map(|rest| (guest.components().count(), host.join(rest)))
        })
        .max_by_key(|(length, _)| *length)
        .map(|(_, host)| host);
    let host = mapped.ok_or(NOENT)?;
    let metadata = fs::symlink_metadata(&host).map_err(map_io)?;
    if metadata.is_symlink() {
        // Interpret targets in the guest namespace, never against the host's root filesystem.
        Ok(Entry::Symlink(fs::read_link(host).map_err(map_io)?))
    } else if metadata.is_dir() {
        Ok(Entry::Directory)
    } else {
        Ok(Entry::File)
    }
}

fn map_io(error: io::Error) -> i32 {
    // Preserve native filesystem failures in WASI's errno domain.
    match error.raw_os_error() {
        Some(libc::EPERM) => -63,
        Some(libc::ENOENT) => NOENT,
        Some(libc::EINTR) => -27,
        Some(libc::EIO) => IO,
        Some(libc::ENOMEM) => -48,
        Some(libc::EACCES) => ACCES,
        Some(libc::ENOTDIR) => NOTDIR,
        Some(libc::EMFILE) => -33,
        Some(libc::ENFILE) => -41,
        Some(libc::ENAMETOOLONG) => -37,
        Some(libc::ELOOP) => -32,
        Some(libc::EOVERFLOW) => -61,
        _ => IO,
    }
}
