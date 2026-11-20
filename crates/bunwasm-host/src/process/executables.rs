//! Original native adapter for Waffle's live executable registry contract.
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, Once, PoisonError};

use super::{ACCES, IO, NOENT, NOTDIR};

pub const DEFAULT_PATHS: [&str; 3] = ["/bin/bun", "/bin/node", "/bin/nodejs"];
pub const SHELL_PATHS: [&str; 2] = ["/bin/sh", "/bin/bash"];
pub const ENV_PATHS: [&str; 2] = ["/bin/env", "/usr/bin/env"];
pub const ENGINE_PATHS: [(&str, [&str; 3]); 3] = [
    (
        "quickjs",
        [
            "/opt/bun/quickjs/bin/bun",
            "/opt/bun/quickjs/bin/node",
            "/opt/bun/quickjs/bin/nodejs",
        ],
    ),
    (
        "jsc",
        [
            "/opt/bun/jsc/bin/bun",
            "/opt/bun/jsc/bin/node",
            "/opt/bun/jsc/bin/nodejs",
        ],
    ),
    (
        "spidermonkey",
        [
            "/opt/bun/spidermonkey/bin/bun",
            "/opt/bun/spidermonkey/bin/node",
            "/opt/bun/spidermonkey/bin/nodejs",
        ],
    ),
];

/// A launcher-owned filesystem root containing real engine capability files.
/// Their implementation is a compiled Wasm module, not a native executable.
/// Removing a file revokes admission even while its module remains registered.
pub struct Executables {
    root: PathBuf,
    pub(super) entries: Mutex<BTreeMap<String, wasmtime::Module>>,
}

/// Roots are named `<ROOT_PREFIX><pid>-<serial>` in the temporary directory.
const ROOT_PREFIX: &str = "bun-wasm-executables-";

/// Roots this process created and has not removed. A runtime that a detached
/// thread still references when the launcher exits is never dropped, so `main`
/// holds [`ProcessRoots`] to remove whatever is left here.
static LIVE_ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Removes every root this process still owns when dropped. `main` holds one
/// for the launcher's lifetime, including its error and panic paths.
pub struct ProcessRoots;

impl Drop for ProcessRoots {
    fn drop(&mut self) {
        let roots = std::mem::take(&mut *LIVE_ROOTS.lock().unwrap_or_else(PoisonError::into_inner));
        for root in roots {
            remove_root(&root);
        }
    }
}

fn remove_root(root: &Path) {
    match fs::remove_dir_all(root) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => eprintln!("bun-wasm: removing {}: {error}", root.display()),
    }
}

/// Remove roots left by launchers that died without cleanup (killed by a
/// signal). A root whose owning process is still running, or that another user
/// owns, stays: its pid answers `kill(pid, 0)` with anything but ESRCH.
fn sweep_dead_roots(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    // SAFETY: geteuid has no preconditions and cannot fail.
    let user = unsafe { libc::geteuid() };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(root_owner) else {
            continue;
        };
        // DirEntry metadata does not follow a symlink.
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_dir() || metadata.uid() != user || process_exists(pid) {
            continue;
        }
        // Another launcher may be sweeping the same root; either removal is fine.
        let _ = fs::remove_dir_all(entry.path());
    }
}

fn root_owner(name: &str) -> Option<libc::pid_t> {
    let (pid, serial) = name.strip_prefix(ROOT_PREFIX)?.split_once('-')?;
    serial.parse::<usize>().ok()?;
    pid.parse().ok().filter(|pid| *pid > 0)
}

fn process_exists(pid: libc::pid_t) -> bool {
    // SAFETY: signal 0 delivers nothing; it only reports whether `pid` exists.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

impl Executables {
    pub fn new(module: &wasmtime::Module) -> io::Result<Self> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        static SWEEP: Once = Once::new();
        let parent = std::env::temp_dir();
        SWEEP.call_once(|| sweep_dead_roots(&parent));
        let root = loop {
            let suffix = NEXT.fetch_add(1, Ordering::Relaxed);
            let candidate = parent.join(format!("{ROOT_PREFIX}{}-{suffix}", std::process::id()));
            match fs::DirBuilder::new().mode(0o700).create(&candidate) {
                Ok(()) => break candidate,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        };
        LIVE_ROOTS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(root.clone());
        let executables = Self {
            root,
            entries: Mutex::default(),
        };
        fs::create_dir_all(executables.root.join("opt/bun"))?;
        fs::create_dir_all(executables.root.join("usr/bin"))?;
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

    pub fn mounts(&self) -> [(PathBuf, String); 3] {
        [
            (self.root.join("bin"), "/bin".into()),
            (self.root.join("opt/bun"), "/opt/bun".into()),
            (self.root.join("usr/bin"), "/usr/bin".into()),
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
        let (path, lexical) = walk(executable, cwd, dirs)?;
        // Match the pinned Waffle registry: a resolved alias cannot change its lexical key.
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

    /// Executable access for PATH search: a registered program, or a `#!` script whose
    /// interpreter is checked only when it runs (as Linux execve reports a bad interpreter).
    pub fn access(&self, executable: &str, cwd: &str, dirs: &[(PathBuf, String)]) -> i32 {
        match self.check(executable, cwd, dirs) {
            Ok(_) => 0,
            Err(ACCES) if script(executable, cwd, dirs).is_some() => 0,
            Err(errno) => errno,
        }
    }

    /// execve: a registered program runs as is. An unregistered regular file starting with `#!`
    /// runs its interpreter with Linux's argv: interpreter, its one optional argument, the script
    /// path as given, then the original arguments. Nesting stops at Linux's four levels (ELOOP).
    pub fn resolve(
        &self,
        executable: &str,
        cwd: &str,
        dirs: &[(PathBuf, String)],
        argv: Vec<String>,
    ) -> Result<Resolved, i32> {
        let mut executable = executable.to_owned();
        let mut argv = argv;
        for _ in 0..=SHEBANG_DEPTH {
            let error = match self.check(&executable, cwd, dirs) {
                Ok((module, path)) => return Ok(Resolved { module, path, argv }),
                Err(error) => error,
            };
            let Some((interpreter, argument)) = (error == ACCES)
                .then(|| script(&executable, cwd, dirs))
                .flatten()
            else {
                return Err(error);
            };
            argv = std::iter::once(interpreter.clone())
                .chain(argument)
                .chain(std::iter::once(executable))
                .chain(argv.into_iter().skip(1))
                .collect();
            executable = interpreter;
        }
        Err(-32) // WASI ELOOP.
    }
}

/// The program a spawn admits, with the argv a `#!` chain produced.
pub struct Resolved {
    pub module: wasmtime::Module,
    pub path: String,
    pub argv: Vec<String>,
}

/// Linux's BINPRM_BUF_SIZE and BINPRM_MAX_RECURSION.
const SHEBANG_BYTES: u64 = 256;
const SHEBANG_DEPTH: usize = 4;

/// The interpreter and optional argument of a regular `#!` file, following symlinks. A FIFO or
/// device is never opened. Like Waffle's registry, there are no execute bits to check: a WASI
/// guest cannot set them, so a bin that Bun's installer writes is an ordinary 0644 file.
fn script(
    executable: &str,
    cwd: &str,
    dirs: &[(PathBuf, String)],
) -> Option<(String, Option<String>)> {
    let (path, _) = walk(executable, cwd, dirs).ok()?;
    let file = host(&path, dirs)?;
    let metadata = fs::metadata(&file).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mut head = Vec::new();
    File::open(file)
        .ok()?
        .take(SHEBANG_BYTES)
        .read_to_end(&mut head)
        .ok()?;
    let line = head.strip_prefix(b"#!")?;
    let line = &line[..line.iter().position(|&b| b == b'\n').unwrap_or(line.len())];
    let line = std::str::from_utf8(line)
        .ok()?
        .trim_matches([' ', '\t', '\r']);
    let (interpreter, argument) = line
        .split_once([' ', '\t'])
        .map_or((line, ""), |(interpreter, rest)| {
            (interpreter, rest.trim_matches([' ', '\t']))
        });
    if interpreter.is_empty() {
        return None;
    }
    Some((
        interpreter.to_owned(),
        (!argument.is_empty()).then(|| argument.to_owned()),
    ))
}

/// The guest path after following every component and symlink, and its lexical form.
fn walk(
    executable: &str,
    cwd: &str,
    dirs: &[(PathBuf, String)],
) -> Result<(PathBuf, PathBuf), i32> {
    let absolute = if executable.starts_with('/') {
        executable.to_string()
    } else {
        format!("{cwd}/{executable}")
    };
    let mut path = PathBuf::from("/");
    let mut remaining: VecDeque<String> = absolute.split('/').skip(1).map(str::to_owned).collect();
    let mut links = 0;
    while let Some(component) = remaining.pop_front() {
        // Inspect each original component, including those before `..` and trailing `/`.
        if !matches!(entry(&path, dirs)?, Entry::Directory) {
            return Err(NOTDIR);
        }
        push_component(&mut path, &component);
        if let Entry::Symlink(target) = entry(&path, dirs)? {
            links += 1;
            follow(&mut path, &target, &mut remaining, links)?;
        }
    }
    if matches!(entry(&path, dirs)?, Entry::Directory) {
        return Err(ACCES);
    }
    // Only after walking every original component, so missing/.. still fails.
    let mut lexical = PathBuf::from("/");
    for component in absolute.split('/') {
        push_component(&mut lexical, component);
    }
    Ok((path, lexical))
}

/// Apply one path component: `..` pops, empty and `.` are no-ops, anything else is pushed.
fn push_component(path: &mut PathBuf, component: &str) {
    match component {
        ".." => drop(path.pop()),
        "" | "." => {}
        part => path.push(part),
    }
}

/// Replace a symlink's own component with its target's components, relative to its directory.
fn follow(
    path: &mut PathBuf,
    target: &Path,
    remaining: &mut VecDeque<String>,
    links: usize,
) -> Result<(), i32> {
    if links > 40 {
        return Err(-32); // WASI ELOOP.
    }
    path.pop();
    if target.is_absolute() {
        *path = PathBuf::from("/");
    }
    let target = target.to_str().ok_or(IO)?;
    for part in target.split('/').rev() {
        remaining.push_front(part.to_owned());
    }
    Ok(())
}

impl Drop for Executables {
    fn drop(&mut self) {
        LIVE_ROOTS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|root| root != &self.root);
        remove_root(&self.root);
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
    let host = host(path, dirs).ok_or(NOENT)?;
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

/// The host file behind a guest path: its deepest mount.
fn host(path: &Path, dirs: &[(PathBuf, String)]) -> Option<PathBuf> {
    dirs.iter()
        .filter_map(|(host, guest)| {
            let guest = Path::new(guest);
            path.strip_prefix(guest)
                .ok()
                .map(|rest| (guest.components().count(), host.join(rest)))
        })
        .max_by_key(|(length, _)| *length)
        .map(|(_, host)| host)
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
