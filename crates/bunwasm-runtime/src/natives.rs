//! Native functions exposed to the JS side of the runtime as the `native`
//! object. The JS polyfills (src/js/*.js) build the public Bun/Node/Web APIs on
//! top of these; nothing here is reachable from user code directly.
//!
//! These natives are engine-agnostic: they take and return plain data
//! ([`Val`]). Byte buffers cross as `Uint8Array` (JS converts other views
//! first), paths are absolute strings, and failures throw Node-style errors
//! (`code`, `errno`, `syscall`, `path`). The natives that need engine values
//! (module loading, promise and proxy introspection) are in
//! Engine-independent data-native definitions.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::mem::ManuallyDrop;
use std::mem::MaybeUninit;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::path::Path;
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::State;
use crate::data::{Args, DataFn, NativeError, NativeResult, Record, Val};
use crate::modules;
use crate::resolve::{Kind, Resolved};

mod fs_path;

fn required_path<'a>(path: &'a str, syscall: &str) -> Result<&'a str, NativeError> {
    fs_path::required(path).map_err(|error| io_error(error, syscall, Some(path)))
}

/// One write attempt: the descriptor it wrote to and the token its caller gave it. A guest
/// counts its tokens up from 1 for its whole life and never reuses one, so an attempt has one
/// name however many channels the guest writes to.
type WriteAttempt = (i32, u64);

thread_local! {
    /// The last `procWriteOnce` that ran in this guest and its result.
    static WRITE_ONCE: std::cell::Cell<(WriteAttempt, i64)> =
        const { std::cell::Cell::new(((0, 0), 0)) };
}

/// `procWriteResult` for an attempt that never ran.
const UNWRITTEN: i64 = i64::MIN;

/// The worker control channel's write. `procWriteOnce(fd, bytes, token)` writes like
/// `procWrite` and keeps its result under its attempt. A caller whose reply was lost after the
/// bytes went out asks the word native `procWriteResult(fd, token high, token low)`, which
/// returns that result only for that same attempt: a call that never reached the core, or
/// another channel's write, reads [`UNWRITTEN`].
fn write_once_natives(t: &mut Table, write: fn(i32, &[u8]) -> i32) {
    t.add("procWriteOnce", move |a| {
        let (fd, bytes, token) = (a.i32(0)?, a.bytes(1)?, a.num(2)? as u64);
        let result = write(fd, bytes);
        WRITE_ONCE.with(|last| last.set(((fd, token), i64::from(result))));
        Ok(result.into())
    });
    t.add_word("procWriteResult", |words| {
        let asked = (
            words[0] as i32,
            (u64::from(words[1]) << 32) | u64::from(words[2]),
        );
        let (attempt, result) = WRITE_ONCE.with(std::cell::Cell::get);
        if asked.1 != 0 && asked == attempt {
            result
        } else {
            UNWRITTEN
        }
    });
}

/// Natives by name, plus constant properties of the `native` object.
#[derive(Default)]
pub struct Table {
    pub functions: Vec<(&'static str, DataFn)>,
    pub constants: Vec<(&'static str, Val)>,
    /// Natives called through the scalar bridge, which has no failure status.
    pub(crate) words: Vec<(&'static str, crate::data::WordFn)>,
}

impl Table {
    pub(crate) fn add(
        &mut self,
        name: &'static str,
        f: impl Fn(Args<'_>) -> NativeResult + 'static,
    ) {
        self.functions.push((name, Rc::new(f)));
    }

    pub(crate) fn add_word(&mut self, name: &'static str, f: crate::data::WordFn) {
        self.words.push((name, f));
    }
}

/// Node's (code, negative Linux errno, description) for an I/O error.
/// Bun's `password_error_instance`: `Password hashing failed with error "WeakParameters"`,
/// code `PASSWORD_WEAK_PARAMETERS`.
fn password_error(err: crate::password::Error, verb: &str) -> NativeError {
    if let crate::password::Error::OutOfMemory(kib) = err {
        return NativeError::error(format!(
            "Password {verb} failed: an Argon2 memory cost of {kib} KiB is more memory than bun-wasm can allocate"
        ))
        .prop("code", "PASSWORD_OUT_OF_MEMORY");
    }
    let name = err.name();
    let mut code = String::from("PASSWORD");
    for ch in name.chars() {
        if ch.is_ascii_uppercase() {
            code.push('_');
        }
        code.push(ch.to_ascii_uppercase());
    }
    NativeError::error(format!("Password {verb} failed with error \"{name}\"")).prop("code", code)
}

fn csrf_error(err: crate::csrf::CsrfError) -> NativeError {
    match err {
        crate::csrf::CsrfError::NoSecret => NativeError::error(
            "Failed to create the default CSRF secret: no secure random source".to_string(),
        ),
        crate::csrf::CsrfError::TokenCreationFailed => {
            NativeError::error("Failed to create CSRF token".to_string())
        }
    }
}

fn errno_info(err: &io::Error) -> (&'static str, i32, &'static str) {
    use io::ErrorKind as K;
    match err.raw_os_error() {
        Some(libc::EBADF) => return ("EBADF", -9, "bad file descriptor"),
        Some(libc::EMFILE) => return ("EMFILE", -24, "too many open files"),
        Some(libc::ENOMEM) => return ("ENOMEM", -12, "not enough memory"),
        Some(libc::ENOSPC) => return ("ENOSPC", -28, "no space left on device"),
        Some(libc::EAGAIN) => return ("EAGAIN", -11, "resource temporarily unavailable"),
        _ => {}
    }
    match err.kind() {
        K::BrokenPipe => ("EPIPE", -32, "broken pipe"),
        K::NotFound => ("ENOENT", -2, "no such file or directory"),
        K::AlreadyExists => ("EEXIST", -17, "file already exists"),
        K::PermissionDenied => ("EACCES", -13, "permission denied"),
        K::NotADirectory => ("ENOTDIR", -20, "not a directory"),
        K::IsADirectory => ("EISDIR", -21, "illegal operation on a directory"),
        K::DirectoryNotEmpty => ("ENOTEMPTY", -39, "directory not empty"),
        K::InvalidInput => ("EINVAL", -22, "invalid argument"),
        K::CrossesDevices => ("EXDEV", -18, "cross-device link not permitted"),
        K::Unsupported => ("ENOSYS", -38, "function not implemented"),
        K::ReadOnlyFilesystem => ("EROFS", -30, "read-only file system"),
        K::FilesystemLoop => ("ELOOP", -40, "too many symbolic links encountered"),
        K::InvalidFilename => ("ENAMETOOLONG", -36, "name too long"),
        _ => ("EIO", -5, "i/o error"),
    }
}

/// A Node-style system error (`ENOENT: no such file or directory, open '/x'`).
pub fn io_error(err: io::Error, syscall: &str, path: Option<&str>) -> NativeError {
    let (code, errno, desc) = errno_info(&err);
    let message = match path {
        Some(p) => format!("{code}: {desc}, {syscall} '{p}'"),
        None => format!("{code}: {desc}, {syscall}"),
    };
    let mut e = NativeError::error(message);
    if let Some(p) = path {
        e = e.prop("path", p);
    }
    e.prop("syscall", syscall)
        .prop("errno", errno)
        .prop("code", code)
}

fn millis(time: io::Result<SystemTime>) -> f64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn io_error_with_dest(err: io::Error, syscall: &str, path: &str, dest: &str) -> NativeError {
    let (code, errno, desc) = errno_info(&err);
    let message = format!("{code}: {desc}, {syscall} '{path}' -> '{dest}'");
    NativeError::error(message)
        .prop("path", path)
        .prop("dest", dest)
        .prop("syscall", syscall)
        .prop("errno", errno)
        .prop("code", code)
}

fn rm_eisdir_error(path: &str) -> NativeError {
    let info = Record::new()
        .set("code", "EISDIR")
        .set("message", "is a directory")
        .set("path", path)
        .set("syscall", "rm")
        .set("errno", 21);
    NativeError::error(format!(
        "Path is a directory: rm returned EISDIR (is a directory) {path}"
    ))
    .prop("name", "SystemError")
    .prop("code", "ERR_FS_EISDIR")
    .prop("errno", 21)
    .prop("syscall", "rm")
    .prop("path", path)
    .prop("info", Val::from(info))
}

#[cfg(any(unix, test))]
fn nanos(time: io::Result<SystemTime>) -> i128 {
    match time {
        Ok(time) => match time.duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_nanos() as i128,
            Err(error) => -(error.duration().as_nanos() as i128),
        },
        Err(_) => 0,
    }
}

fn metadata_integer(value: u64, bigint: bool) -> Val {
    if bigint {
        Val::BigUint(value)
    } else {
        Val::Num(value as f64)
    }
}

#[cfg(unix)]
type StatMetadata = fs::Metadata;
#[cfg(target_os = "wasi")]
type StatMetadata = libc::stat;

#[cfg(target_os = "wasi")]
mod wasi_metadata;

fn metadata_record(
    integers: [(&str, u64); 8],
    signed: [(&str, i64); 2],
    times: [(&str, i128); 4],
    bigint: bool,
) -> Val {
    let mut record = Record::new();
    for (name, value) in integers {
        record.push(name, metadata_integer(value, bigint));
    }
    for (name, value) in signed {
        record.push(
            name,
            if bigint {
                Val::BigInt(value)
            } else {
                Val::Num(value as f64)
            },
        );
    }
    for (name, value) in times {
        if bigint {
            record.push(&format!("{name}Ms"), (value / 1_000_000).to_string());
            record.push(&format!("{name}Ns"), value.to_string());
            continue;
        }
        // Bun's Stat.rs `to_time_ms_f64`: seconds and nanoseconds convert separately. One
        // f64 division of the whole nanosecond count (above 2^53 for any time after April
        // 1970) turns 1700000000.25 s into 1700000000249.9998 ms.
        let (seconds, nanos) = (
            value.div_euclid(1_000_000_000),
            value.rem_euclid(1_000_000_000),
        );
        record.push(
            &format!("{name}Ms"),
            seconds as f64 * 1000.0 + nanos as f64 / 1_000_000.0,
        );
    }
    record.into()
}

#[cfg(unix)]
fn stat_record(_state: &State, meta: &StatMetadata, bigint: bool) -> Val {
    use std::os::unix::fs::MetadataExt;
    metadata_record(
        [
            ("dev", meta.dev()),
            ("ino", meta.ino()),
            ("mode", u64::from(meta.mode())),
            ("nlink", meta.nlink()),
            ("uid", u64::from(meta.uid())),
            ("gid", u64::from(meta.gid())),
            ("rdev", meta.rdev()),
            ("size", meta.len()),
        ],
        [
            ("blksize", meta.blksize() as i64),
            ("blocks", meta.blocks() as i64),
        ],
        [
            ("atime", nanos(meta.accessed())),
            ("mtime", nanos(meta.modified())),
            (
                "ctime",
                i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()),
            ),
            ("birthtime", nanos(meta.created())),
        ],
        bigint,
    )
}

#[cfg(target_os = "wasi")]
fn stat_record(state: &State, stat: &StatMetadata, bigint: bool) -> Val {
    let timestamp =
        |time: &libc::timespec| i128::from(time.tv_sec) * 1_000_000_000 + i128::from(time.tv_nsec);
    let mode = state
        .modes
        .borrow()
        .get(&(stat.st_dev, stat.st_ino))
        .copied()
        .map(|perms| (stat.st_mode & 0o170000) | (perms & 0o7777))
        .unwrap_or_else(|| wasi_metadata::mode(stat.st_mode));
    metadata_record(
        [
            ("dev", stat.st_dev),
            ("ino", stat.st_ino),
            ("mode", u64::from(mode)),
            ("nlink", stat.st_nlink),
            ("uid", u64::from(stat.st_uid)),
            ("gid", u64::from(stat.st_gid)),
            ("rdev", stat.st_rdev),
            ("size", stat.st_size as u64),
        ],
        [
            ("blksize", i64::from(stat.st_blksize)),
            ("blocks", stat.st_blocks),
        ],
        [
            ("atime", timestamp(&stat.st_atim)),
            ("mtime", timestamp(&stat.st_mtim)),
            ("ctime", timestamp(&stat.st_ctim)),
            ("birthtime", 0),
        ],
        bigint,
    )
}

#[cfg(any(target_os = "wasi", test))]
fn mask_creation_mode(mode: u32, umask: u32) -> u32 {
    (mode & 0o7000) | ((mode & 0o777) & !umask)
}

// Linux/Bun mkdir(2) honors the sticky bit (0o1000) and ignores setuid/setgid (0o6000).
#[cfg(any(target_os = "wasi", test))]
fn mask_dir_creation_mode(mode: u32, umask: u32) -> u32 {
    (mode & 0o1000) | ((mode & 0o777) & !umask)
}

#[cfg(any(target_os = "wasi", test))]
fn should_clear_inode(is_dir: bool, nlink: u64, removed_links: u64) -> bool {
    is_dir || removed_links >= nlink
}

#[cfg(target_os = "wasi")]
fn record_inode_mode(state: &State, stat: &StatMetadata, perms: u32) {
    state
        .modes
        .borrow_mut()
        .insert((stat.st_dev, stat.st_ino), perms & 0o7777);
}

#[cfg(target_os = "wasi")]
fn record_path_mode(state: &State, path: &str, perms: u32, lstat: bool) {
    if let Ok(stat) = path_metadata(path, lstat) {
        record_inode_mode(state, &stat, perms);
    }
}

#[cfg(target_os = "wasi")]
fn pending_mode_clear(path: &str) -> Vec<(u64, u64)> {
    let Ok(stat) = path_metadata(path, true) else {
        return Vec::new();
    };
    let is_dir = (stat.st_mode & 0o170000) == 0o040000;
    if should_clear_inode(is_dir, stat.st_nlink, 1) {
        vec![(stat.st_dev, stat.st_ino)]
    } else {
        Vec::new()
    }
}

#[cfg(target_os = "wasi")]
fn pending_tree_mode_clears(root: &str) -> Vec<(u64, u64)> {
    let mut counts: std::collections::HashMap<(u64, u64), (bool, u64, u64)> =
        std::collections::HashMap::new();
    let mut stack = vec![std::path::PathBuf::from(root)];
    while let Some(current) = stack.pop() {
        let Some(text) = current.to_str() else {
            continue;
        };
        let Ok(stat) = path_metadata(text, true) else {
            continue;
        };
        let is_dir = (stat.st_mode & 0o170000) == 0o040000;
        let entry = counts
            .entry((stat.st_dev, stat.st_ino))
            .or_insert((is_dir, stat.st_nlink, 0));
        entry.2 += 1;
        if is_dir && let Ok(entries) = fs::read_dir(&current) {
            for child in entries.flatten() {
                stack.push(child.path());
            }
        }
    }
    counts
        .into_iter()
        .filter_map(|(key, (is_dir, nlink, removed))| {
            should_clear_inode(is_dir, nlink, removed).then_some(key)
        })
        .collect()
}

#[cfg(target_os = "wasi")]
fn finish_mode_clears(state: &State, keys: Vec<(u64, u64)>) {
    if keys.is_empty() {
        return;
    }
    let mut modes = state.modes.borrow_mut();
    for key in keys {
        modes.remove(&key);
    }
}

#[cfg(target_os = "wasi")]
fn effective_permissions(state: &State, stat: &StatMetadata) -> u32 {
    state
        .modes
        .borrow()
        .get(&(stat.st_dev, stat.st_ino))
        .copied()
        .unwrap_or_else(|| wasi_metadata::mode(stat.st_mode) & 0o7777)
}

#[cfg(unix)]
fn path_metadata(path: &str, lstat: bool) -> io::Result<StatMetadata> {
    if lstat {
        fs::symlink_metadata(path)
    } else {
        fs::metadata(path)
    }
}

#[cfg(target_os = "wasi")]
fn path_metadata(path: &str, lstat: bool) -> io::Result<StatMetadata> {
    let path = std::ffi::CString::new(path).map_err(|_| io::ErrorKind::InvalidInput)?;
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    let status = if lstat {
        unsafe { libc::lstat(path.as_ptr(), stat.as_mut_ptr()) }
    } else {
        unsafe { libc::stat(path.as_ptr(), stat.as_mut_ptr()) }
    };
    if status < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { stat.assume_init() })
}

#[cfg(unix)]
fn same_file(from: &str, to: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Ok(src), Ok(dst)) = (path_metadata(from, false), path_metadata(to, false)) else {
        return false;
    };
    !src.is_dir() && !dst.is_dir() && src.dev() == dst.dev() && src.ino() == dst.ino()
}

#[cfg(target_os = "wasi")]
fn same_file(from: &str, to: &str) -> bool {
    let (Ok(src), Ok(dst)) = (path_metadata(from, false), path_metadata(to, false)) else {
        return false;
    };
    (src.st_mode & 0o170000) != 0o040000
        && (dst.st_mode & 0o170000) != 0o040000
        && src.st_dev == dst.st_dev
        && src.st_ino == dst.st_ino
}

#[cfg(not(any(unix, target_os = "wasi")))]
fn same_file(_from: &str, _to: &str) -> bool {
    false
}

fn copy_file(from: &str, to: &str, flags: i32) -> io::Result<()> {
    if flags & !3 != 0 {
        return Err(io::ErrorKind::Unsupported.into());
    }
    if flags & 1 == 0 {
        if same_file(from, to) {
            return Ok(());
        }
        fs::copy(from, to)?;
        return Ok(());
    }
    let mut source = File::open(from)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let permissions = source.metadata()?.permissions();
        options.mode(permissions.mode());
        permissions
    };
    let mut destination = options.open(to)?;
    io::copy(&mut source, &mut destination)?;
    #[cfg(unix)]
    destination.set_permissions(permissions)?;
    Ok(())
}

#[derive(Clone, Copy, Default)]
enum SyncMode {
    #[default]
    None,
    Data,
    All,
}

fn sync_mode(flags: i32) -> SyncMode {
    if flags & 1052672 == 1052672 {
        return SyncMode::All;
    }
    if flags & 4096 != 0 {
        return SyncMode::Data;
    }
    SyncMode::None
}

#[cfg(any(target_os = "wasi", unix))]
fn sync_fd(fd: i32, mode: SyncMode) -> io::Result<()> {
    let status = match mode {
        SyncMode::None => return Ok(()),
        #[cfg(any(target_os = "wasi", target_os = "linux"))]
        SyncMode::Data => unsafe { libc::fdatasync(fd) },
        #[cfg(all(unix, not(target_os = "linux")))]
        SyncMode::Data => unsafe { libc::fsync(fd) },
        SyncMode::All => unsafe { libc::fsync(fd) },
    };
    if status < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(target_os = "wasi", unix)))]
fn sync_fd(_fd: i32, _mode: SyncMode) -> io::Result<()> {
    Ok(())
}

fn sync_explicit_fd(state: &State, fd: i32, mode: SyncMode) -> io::Result<()> {
    if state.fds.borrow().is_stdio_attached(fd) {
        let stat = descriptor_metadata(fd)?;
        #[cfg(target_os = "wasi")]
        let non_file = matches!(stat.st_mode & 0o170000, 0o010000 | 0o020000 | 0o140000);
        #[cfg(unix)]
        let non_file = !stat.is_file();
        if non_file {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        return flush_descriptor_output(state);
    }
    // On WASI, wasi-libc omits RIGHT_FD_DATASYNC on read-only opens, which Waffle
    // enforces with EBADF while host Bun allows fdatasync on read-only fds. Using fsync
    // provides a stronger barrier and succeeds on both read-only and writable descriptors.
    #[cfg(target_os = "wasi")]
    let mode = match mode {
        SyncMode::Data => SyncMode::All,
        other => other,
    };
    sync_fd(fd, mode)
}

/// Own files opened by this runtime, indexed by their real process descriptor.
/// Inherited descriptors share that namespace and remain owned by the process host.
#[derive(Default)]
pub struct FdTable {
    files: HashMap<i32, File>,
    sync_modes: HashMap<i32, SyncMode>,
    detached_stdio: [bool; 3],
}

impl FdTable {
    fn is_stdio_attached(&self, fd: i32) -> bool {
        usize::try_from(fd)
            .ok()
            .and_then(|i| self.detached_stdio.get(i))
            .is_some_and(|&detached| !detached)
    }

    fn detach_stdio(&mut self, fd: i32) {
        if let Ok(index) = usize::try_from(fd)
            && let Some(slot) = self.detached_stdio.get_mut(index)
        {
            *slot = true;
        }
    }
}

fn synchronize_descriptor(state: &State, fd: i32, written: usize) -> io::Result<()> {
    if written == 0 {
        return Ok(());
    }
    let mode = state
        .fds
        .borrow()
        .sync_modes
        .get(&fd)
        .copied()
        .unwrap_or_default();
    sync_fd(fd, mode)
}

fn descriptor_metadata(fd: i32) -> io::Result<StatMetadata> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // Validate the descriptor before borrowing it. Guest native calls are synchronous;
    // no JS can close or reuse it between this check and metadata().
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    #[cfg(unix)]
    {
        // Borrow inherited descriptors without taking ownership of their lifetime.
        let file = ManuallyDrop::new(unsafe { File::from_raw_fd(fd as _) });
        file.metadata()
    }
    #[cfg(target_os = "wasi")]
    {
        let mut stat = unsafe { stat.assume_init() };
        // Preview1 UNKNOWN is not a pipe tag. Preserve fstat's capability check and
        // consult the process resource only to restore FIFO's missing POSIX bits.
        stat.st_mode = descriptor_mode(stat.st_mode, crate::host::proc_fd_kind(fd))?;
        Ok(stat)
    }
}

#[cfg(any(target_os = "wasi", test))]
fn descriptor_mode(mode: libc::mode_t, kind: i32) -> io::Result<libc::mode_t> {
    if kind < 0 {
        return Err(io::Error::from_raw_os_error(-kind));
    }
    Ok(if kind == 1 {
        (mode & !0o170000) | 0o010000
    } else {
        mode
    })
}

fn descriptor_stat(state: &State, fd: i32, bigint: bool) -> io::Result<Val> {
    Ok(stat_record(state, &descriptor_metadata(fd)?, bigint))
}

// Public Node constants use Linux bit values, independent of the libc target.
fn open_file(path: &str, flags: i32, mode: u32) -> io::Result<File> {
    let supported = 3 | 64 | 128 | 512 | 1024 | 65536 | 131072 | 1052672;
    if flags & !supported != 0 {
        return Err(io::ErrorKind::Unsupported.into());
    }
    let mut host_flags = match flags & 3 {
        0 => libc::O_RDONLY,
        1 => libc::O_WRONLY,
        2 => libc::O_RDWR,
        _ => return Err(io::ErrorKind::InvalidInput.into()),
    };
    for (public, host) in [
        (64, libc::O_CREAT),
        (128, libc::O_EXCL),
        (512, libc::O_TRUNC),
        (1024, libc::O_APPEND),
        (65536, libc::O_DIRECTORY),
        (131072, libc::O_NOFOLLOW),
        (4096, libc::O_DSYNC),
        (1052672, libc::O_SYNC),
    ] {
        if flags & public == public {
            host_flags |= host;
        }
    }
    #[cfg(target_os = "wasi")]
    {
        // Preview1 hosts can reject sync open flags. Owned descriptors retain the
        // mode and their write paths issue the corresponding explicit barrier.
        host_flags &= !(libc::O_SYNC | libc::O_DSYNC);
    }
    host_flags |= libc::O_CLOEXEC;
    let path = fs_path::required(path)?;
    let path = std::ffi::CString::new(path).map_err(|_| io::ErrorKind::InvalidInput)?;
    let fd = unsafe { libc::open(path.as_ptr(), host_flags, mode as libc::mode_t) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // open() transferred ownership of this fresh descriptor to us.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn write_file(
    state: &State,
    path: &str,
    bytes: &[u8],
    flags: i32,
    mode: u32,
    umask: u32,
) -> NativeResult {
    #[cfg(target_os = "wasi")]
    let existed = flags & 64 != 0 && fs::symlink_metadata(path).is_ok();
    let mut file = open_file(path, flags, mode).map_err(|e| io_error(e, "open", Some(path)))?;
    #[cfg(target_os = "wasi")]
    if flags & 64 != 0
        && !existed
        && let Ok(stat) = descriptor_metadata(file.as_raw_fd())
    {
        record_inode_mode(state, &stat, mask_creation_mode(mode, umask));
    }
    #[cfg(not(target_os = "wasi"))]
    let _ = (state, umask);
    file.write_all(bytes)
        .map_err(|e| io_error(e, "write", Some(path)))?;
    sync_fd(file.as_raw_fd(), sync_mode(flags)).map_err(|e| io_error(e, "write", Some(path)))?;
    Ok(Val::Num(bytes.len() as f64))
}

/// Every data native.
/// Natives that can add, remove or rename a path. `open` and `sqlite.open` do only when their
/// flags (argument 1) may create the file: Linux O_CREAT, as the JS layer passes it, and
/// SQLITE_OPEN_CREATE.
const PATH_CHANGES: &[(&str, Option<i32>)] = &[
    ("writeFile", None),
    ("writeFileFlags", None),
    ("mkdir", None),
    ("rm", None),
    ("rmdir", None),
    ("unlink", None),
    ("rename", None),
    ("copyFile", None),
    ("symlink", None),
    ("link", None),
    ("archive.extract", None),
    ("open", Some(64)),
    ("sqlite.open", Some(0x4)),
];

/// After a native that may have changed which path a require() finds, forget the remembered
/// targets and the read a pending compile would reuse (`State::paths_changed`), whether or
/// not the call succeeded.
fn forget_required_after_path_changes(t: &mut Table, state: &Rc<State>) {
    for (name, function) in t.functions.iter_mut() {
        let change = PATH_CHANGES.iter().find(|(key, _)| key == name);
        if let Some(&(_, create_flag)) = change {
            *function = forgetting_required(function.clone(), state.clone(), create_flag);
        }
    }
}

/// `inner`, followed by `State::paths_changed` unless its flags rule out creating a path.
fn forgetting_required(inner: DataFn, st: Rc<State>, create_flag: Option<i32>) -> DataFn {
    Rc::new(move |a| {
        let changes =
            create_flag.is_none_or(|bit| a.opt_num(1).is_some_and(|flags| flags as i32 & bit != 0));
        let result = inner(a);
        if changes {
            st.paths_changed();
        }
        result
    })
}

pub fn table(state: &Rc<State>) -> Table {
    let mut t = Table::default();
    crate::html_rewriter::install(&mut t);
    crate::x509::install(&mut t);
    install_process(&mut t, state);
    t.add("packageScriptsHandoff", |a| {
        Ok(Val::Num(
            crate::host::package_scripts_handoff(a.str(0)?) as f64
        ))
    });
    install_fs(&mut t, state);
    install_fds(&mut t, state);
    crate::directory::install(&mut t, state);
    install_modules(&mut t, state);
    let st = state.clone();
    t.add("parseData", move |a| {
        st.transpiler
            .parse_data(a.bytes(0)?, a.str(1)?)
            .map(Val::Str)
    });
    crate::glob::install(&mut t);
    crate::semver::install(&mut t);
    crate::test_diff::install(&mut t);
    t.add("bunStringRoundTrip", |a| {
        bun_string_round_trip(a.bytes(0)?, a.str(1)?)
    });
    // The size of the one linear memory the core and every engine side allocate from, read by
    // the core itself: engines report process.memoryUsage().rss differently (JSC: null).
    #[cfg(target_arch = "wasm32")]
    t.add("linearMemoryBytes", |_| {
        Ok(Val::Num(
            (core::arch::wasm32::memory_size(0) * 65_536) as f64,
        ))
    });
    crate::parse_env::install(&mut t);
    crate::time_zone::install(&mut t);
    crate::node_path::install(&mut t);
    install_encoding(&mut t);
    crate::streams::install(&mut t);
    crate::archive::install(&mut t);
    install_crypto(&mut t);
    crate::node_cipher::install(&mut t);
    crate::tls::install(&mut t, state.tls.clone());
    install_url(&mut t);
    crate::intl::install(&mut t);
    install_host(&mut t, state);
    crate::sqlite::install(&mut t);
    #[cfg(feature = "engine-split")]
    crate::wasm::install(&mut t);
    // Last, so it sees every native that can create a path.
    forget_required_after_path_changes(&mut t, state);
    t.constants.push(("platformInfo", platform_info()));
    t
}

/// bun:internal-for-testing: wrap a fresh copy of `bytes` in Bun's own `String` and decode it
/// again through Bun's `EncodedSlice`. Reports where the decoded bytes live, so a guest can
/// prove real Bun strings work above the old 512 MiB pointer-tag boundary.
fn bun_string_round_trip(bytes: &[u8], encoding: &str) -> NativeResult {
    let owned = bytes.to_vec();
    let words: Vec<u16> = match encoding {
        "utf16le" => owned
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect(),
        _ => Vec::new(),
    };
    let encoded = match encoding {
        "latin1" => bun_core::EncodedSlice::latin1(&owned),
        "utf8" => bun_core::EncodedSlice::utf8(&owned),
        "utf16le" => bun_core::EncodedSlice::utf16(&words),
        _ => return Err(NativeError::type_error("unsupported encoding")),
    };
    let string = bun_core::StringView::from_encoded(encoded);
    let decoded = string.byte_slice();
    Ok(Val::Object(vec![
        ("address".into(), Val::Num(decoded.as_ptr() as usize as f64)),
        ("bytes".into(), Val::Bytes(decoded.to_vec())),
    ]))
}

fn ok() -> NativeResult {
    Ok(Val::Undefined)
}

fn install_process(t: &mut Table, state: &Rc<State>) {
    let st = state.clone();
    t.add("writeStdout", move |a| {
        st.write_stdout(a.bytes(0)?)
            .map_err(|e| io_error(e, "write", None))?;
        if a.bool(1) {
            st.flush_stdout().map_err(|e| io_error(e, "write", None))?;
        }
        ok()
    });
    let st = state.clone();
    t.add("writeStderr", move |a| {
        st.write_stderr(a.bytes(0)?)
            .map_err(|e| io_error(e, "write", None))?;
        ok()
    });
    let st = state.clone();
    t.add("exit", move |a| st.exit(a.opt_num(0).unwrap_or(0.0) as i32));
    let st = state.clone();
    t.add("argv", move |_| {
        Ok(Val::Array(
            st.argv.iter().map(|s| Val::from(s.as_str())).collect(),
        ))
    });
    let st = state.clone();
    t.add("execArgv", move |_| {
        Ok(Val::Array(
            st.exec_argv.iter().map(|s| Val::from(s.as_str())).collect(),
        ))
    });
    let st = state.clone();
    t.add("experimentalStreamIter", move |_| {
        Ok(Val::Bool(st.experimental_stream_iter))
    });
    // Host-owned metadata, independent of the caller-controlled preview1 argv[0] and PATH.
    t.add("execPath", |_| {
        Ok(std::env::var("BUNWASM_EXEC_PATH")
            .unwrap_or_else(|_| "/bin/bun".into())
            .into())
    });
    let st = state.clone();
    t.add("mainPath", move |_| Ok(st.main.borrow().clone().into()));
    let st = state.clone();
    t.add("setMainPath", move |a| {
        *st.main.borrow_mut() = a.string(0)?;
        ok()
    });
    let st = state.clone();
    t.add("mainArg", move |_| Ok(st.main_arg.borrow().clone().into()));
    let st = state.clone();
    t.add("runMode", move |_| {
        Ok(if st.mode == crate::RunMode::Hot {
            "hot"
        } else {
            "once"
        }
        .into())
    });
    t.add("env", |_| {
        let fields = std::env::vars_os()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    Val::Str(v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        Ok(Val::Object(fields))
    });
    let st = state.clone();
    t.add("cwd", move |_| Ok(st.cwd().into()));
    t.add("chdir", |a| {
        let path = a.str(0)?;
        std::env::set_current_dir(path).map_err(|e| io_error(e, "chdir", Some(path)))?;
        ok()
    });
    let st = state.clone();
    t.add("now", move |_| {
        Ok(Val::Num(st.start.elapsed().as_secs_f64() * 1000.0))
    });
    let st = state.clone();
    t.add("nanoseconds", move |_| {
        Ok(Val::Num(st.start.elapsed().as_nanos() as f64))
    });
    t.add("timeOrigin", |_| {
        Ok(Val::Num(millis(Ok(SystemTime::now()))))
    });
    let st = state.clone();
    t.add("sleep", move |a| {
        st.flush();
        let ms = a.opt_num(0).unwrap_or(0.0);
        if ms > 0.0 {
            st.sleep(Duration::from_secs_f64(ms / 1000.0));
        }
        ok()
    });
    t.add("isatty", |a| {
        use std::io::IsTerminal;
        let tty = match a.i32(0)? {
            0 => io::stdin().is_terminal(),
            1 => io::stdout().is_terminal(),
            2 => io::stderr().is_terminal(),
            _ => false,
        };
        Ok(tty.into())
    });
    let st = state.clone();
    t.add("readStdin", move |_| {
        // Make buffered readiness output visible before waiting for parent input.
        st.flush();
        let mut buf = Vec::new();
        io::stdin()
            .read_to_end(&mut buf)
            .map_err(|e| io_error(e, "read", None))?;
        Ok(Val::Bytes(buf))
    });
    let st = state.clone();
    t.add("scheduleTick", move |_| {
        st.tick_pending.set(true);
        ok()
    });
}

#[cfg(test)]
mod mkdir_tests;
#[cfg(test)]
mod rm_tests;

fn create_dir_with_mode(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let cpath = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| io::ErrorKind::InvalidInput)?;
        if unsafe { libc::mkdir(cpath.as_ptr(), mode as libc::mode_t) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        fs::create_dir(path)
    }
}

fn mkdir_recursive(path: &str, mode: u32) -> io::Result<(Option<String>, Vec<String>)> {
    let mut pending = vec![Path::new(path)];
    let mut first = None;
    let mut created = Vec::new();
    while let Some(current) = pending.pop() {
        let Err(error) = create_dir_with_mode(current, mode) else {
            first = first.or(Some(current));
            created.push(current.to_string_lossy().into_owned());
            continue;
        };
        if error.kind() == io::ErrorKind::AlreadyExists
            && fs::metadata(current).is_ok_and(|metadata| metadata.is_dir())
        {
            continue;
        }
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error);
        }
        let parent = current.parent().ok_or(error)?;
        pending.push(current);
        pending.push(parent);
    }
    Ok((
        first.map(|path| path.to_string_lossy().into_owned()),
        created,
    ))
}

fn split_trailing_slash(path: &str) -> (&str, bool) {
    let has_trailing_slash = path.ends_with('/') && path.bytes().any(|b| b != b'/');
    let target = if has_trailing_slash {
        path.trim_end_matches('/')
    } else {
        path
    };
    (target, has_trailing_slash)
}

fn remove_path(
    state: &State,
    path: &str,
    recursive: bool,
    force: bool,
    syscall: &str,
) -> NativeResult {
    let (target, has_trailing_slash) = split_trailing_slash(path);
    let meta = match fs::symlink_metadata(target) {
        Ok(m) => m,
        Err(e) if force && e.kind() == io::ErrorKind::NotFound => return ok(),
        Err(e) => return Err(io_error(e, syscall, Some(path))),
    };
    if has_trailing_slash && (meta.file_type().is_symlink() || !meta.is_dir()) {
        if !recursive
            && meta.file_type().is_symlink()
            && fs::metadata(target).is_ok_and(|resolved| resolved.is_dir())
        {
            return Err(rm_eisdir_error(path));
        }
        return Err(io_error(
            io::Error::from(io::ErrorKind::NotADirectory),
            syscall,
            Some(path),
        ));
    }
    if meta.is_dir() && !recursive {
        return Err(rm_eisdir_error(path));
    }
    #[cfg(target_os = "wasi")]
    let pending = if meta.is_dir() {
        pending_tree_mode_clears(target)
    } else {
        pending_mode_clear(target)
    };
    let result = if meta.is_dir() {
        fs::remove_dir_all(target)
    } else {
        fs::remove_file(target)
    };
    result.map_err(|e| io_error(e, syscall, Some(path)))?;
    #[cfg(target_os = "wasi")]
    finish_mode_clears(state, pending);
    #[cfg(not(target_os = "wasi"))]
    let _ = state;
    ok()
}

fn remove_dir_non_recursive(state: &State, path: &str) -> NativeResult {
    let (target, has_trailing_slash) = split_trailing_slash(path);
    if has_trailing_slash {
        let meta = fs::symlink_metadata(target).map_err(|e| io_error(e, "rmdir", Some(path)))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(io_error(
                io::Error::from(io::ErrorKind::NotADirectory),
                "rmdir",
                Some(path),
            ));
        }
    }
    #[cfg(target_os = "wasi")]
    let pending = pending_mode_clear(target);
    fs::remove_dir(target).map_err(|e| io_error(e, "rmdir", Some(path)))?;
    #[cfg(target_os = "wasi")]
    finish_mode_clears(state, pending);
    #[cfg(not(target_os = "wasi"))]
    let _ = state;
    ok()
}

fn install_fs(t: &mut Table, state: &Rc<State>) {
    t.add("readFile", |a| {
        let path = required_path(a.str(0)?, "open")?;
        let flags = a.opt_num(1).map(|n| n as i32).unwrap_or(0);
        if flags == 0 {
            return Ok(Val::Bytes(
                fs::read(path).map_err(|e| io_error(e, "open", Some(path)))?,
            ));
        }
        let mut file =
            open_file(path, flags, 0o666).map_err(|e| io_error(e, "open", Some(path)))?;
        if flags & 3 == 1 {
            return Err(io_error(
                io::Error::from_raw_os_error(libc::EBADF),
                "read",
                None,
            ));
        }
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| io_error(e, "read", Some(path)))?;
        Ok(Val::Bytes(buf))
    });
    t.add("readFileUtf8", |a| {
        let path = required_path(a.str(0)?, "open")?;
        let bytes = fs::read(path).map_err(|e| io_error(e, "open", Some(path)))?;
        Ok(String::from_utf8(bytes)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
            .into())
    });
    let st = state.clone();
    t.add("writeFile", move |a| {
        write_file(
            &st,
            a.str(0)?,
            a.bytes(1)?,
            if a.bool(2) { 1089 } else { 577 },
            0o666,
            0o022,
        )
    });
    let st = state.clone();
    t.add("writeFileFlags", move |a| {
        write_file(
            &st,
            a.str(0)?,
            a.bytes(1)?,
            a.i32(2)?,
            a.opt_num(3).unwrap_or(438.0) as u32,
            a.opt_num(4).unwrap_or(18.0) as u32,
        )
    });
    t.add("exists", |a| {
        let path = a.str(0)?;
        Ok((!path.is_empty() && fs::symlink_metadata(path).is_ok()).into())
    });
    let st = state.clone();
    t.add("stat", move |a| {
        let lstat = a.bool(1);
        let path = required_path(a.str(0)?, if lstat { "lstat" } else { "stat" })?;
        let stat = path_metadata(path, lstat)
            .map_err(|e| io_error(e, if lstat { "lstat" } else { "stat" }, Some(path)))?;
        Ok(stat_record(&st, &stat, a.bool(2)))
    });
    let st = state.clone();
    t.add("mkdir", move |a| {
        let path = required_path(a.str(0)?, "mkdir")?;
        let mode = a.opt_num(2).unwrap_or(0o777 as f64) as u32;
        let umask = a.opt_num(3).unwrap_or(0o022 as f64) as u32;
        if !a.bool(1) {
            create_dir_with_mode(Path::new(path), mode)
                .map_err(|e| io_error(e, "mkdir", Some(path)))?;
            #[cfg(target_os = "wasi")]
            record_path_mode(&st, path, mask_dir_creation_mode(mode, umask), true);
            #[cfg(not(target_os = "wasi"))]
            let _ = (&st, umask);
            return Ok(Val::Null);
        }
        let (first, created) =
            mkdir_recursive(path, mode).map_err(|e| io_error(e, "mkdir", Some(path)))?;
        #[cfg(target_os = "wasi")]
        {
            let effective = mask_dir_creation_mode(mode, umask);
            for dir in &created {
                record_path_mode(&st, dir, effective, true);
            }
        }
        #[cfg(not(target_os = "wasi"))]
        let _ = (&st, created, umask);
        Ok(first.map_or(Val::Null, Val::Str))
    });
    let st = state.clone();
    t.add("chmod", move |a| {
        let path = required_path(a.str(0)?, "chmod")?;
        let mode = a.num(1)? as u32;
        #[cfg(unix)]
        {
            let _ = &st;
            let cpath = std::ffi::CString::new(path)
                .map_err(|_| io_error(io::ErrorKind::InvalidInput.into(), "chmod", Some(path)))?;
            if unsafe { libc::chmod(cpath.as_ptr(), (mode & 0o7777) as libc::mode_t) } < 0 {
                return Err(io_error(io::Error::last_os_error(), "chmod", Some(path)));
            }
        }
        #[cfg(target_os = "wasi")]
        {
            let stat = path_metadata(path, false).map_err(|e| io_error(e, "chmod", Some(path)))?;
            record_inode_mode(&st, &stat, mode);
        }
        ok()
    });
    let st = state.clone();
    t.add("fchmod", move |a| {
        let fd = a.i32(0)?;
        let mode = a.num(1)? as u32;
        #[cfg(unix)]
        {
            let _ = &st;
            if unsafe { libc::fchmod(fd, (mode & 0o7777) as libc::mode_t) } < 0 {
                return Err(io_error(io::Error::last_os_error(), "fchmod", None));
            }
        }
        #[cfg(target_os = "wasi")]
        {
            let stat = descriptor_metadata(fd).map_err(|e| io_error(e, "fchmod", None))?;
            record_inode_mode(&st, &stat, mode);
        }
        ok()
    });
    t.add("readdir", |a| {
        let path = required_path(a.str(0)?, "scandir")?;
        let entries = fs::read_dir(path).map_err(|e| io_error(e, "scandir", Some(path)))?;
        let mut list = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| io_error(e, "scandir", Some(path)))?;
            let kind = match entry.file_type() {
                Ok(t) if t.is_dir() => "dir",
                Ok(t) if t.is_symlink() => "symlink",
                Ok(t) if t.is_file() => "file",
                _ => "other",
            };
            // Host directory order, like Node (no sorting).
            let name = entry.file_name().to_string_lossy().into_owned();
            list.push(Val::Array(vec![Val::Str(name), kind.into()]));
        }
        Ok(Val::Array(list))
    });
    let st = state.clone();
    t.add("rm", move |a| {
        let path = a.str(0)?;
        if path.is_empty() && a.bool(2) {
            return ok();
        }
        let path = required_path(path, "rm")?;
        remove_path(&st, path, a.bool(1), a.bool(2), "rm")
    });
    let st = state.clone();
    t.add("rmdir", move |a| {
        let path = required_path(a.str(0)?, "rmdir")?;
        if a.bool(1) {
            return remove_path(&st, path, true, false, "rm");
        }
        remove_dir_non_recursive(&st, path)
    });
    let st = state.clone();
    t.add("unlink", move |a| {
        let path = required_path(a.str(0)?, "unlink")?;
        #[cfg(target_os = "wasi")]
        let pending = pending_mode_clear(path);
        fs::remove_file(path).map_err(|e| io_error(e, "unlink", Some(path)))?;
        #[cfg(target_os = "wasi")]
        finish_mode_clears(&st, pending);
        #[cfg(not(target_os = "wasi"))]
        let _ = &st;
        ok()
    });
    let st = state.clone();
    t.add("rename", move |a| {
        let (from, to) = (a.str(0)?, a.str(1)?);
        required_path(from, "rename")?;
        required_path(to, "rename")?;
        #[cfg(target_os = "wasi")]
        let src_key = path_metadata(from, true)
            .ok()
            .map(|stat| (stat.st_dev, stat.st_ino));
        #[cfg(target_os = "wasi")]
        let pending = pending_mode_clear(to);
        fs::rename(from, to).map_err(|e| io_error(e, "rename", Some(from)))?;
        #[cfg(target_os = "wasi")]
        finish_mode_clears(
            &st,
            pending
                .into_iter()
                .filter(|key| Some(*key) != src_key)
                .collect(),
        );
        #[cfg(not(target_os = "wasi"))]
        let _ = &st;
        ok()
    });
    let st = state.clone();
    t.add("copyFile", move |a| {
        let (from, to) = (a.str(0)?, a.str(1)?);
        required_path(from, "copyfile")?;
        required_path(to, "copyfile")?;
        #[cfg(target_os = "wasi")]
        let src_mode = path_metadata(from, false)
            .ok()
            .map(|stat| effective_permissions(&st, &stat));
        copy_file(from, to, a.opt_num(2).unwrap_or(0.0) as i32)
            .map_err(|e| io_error_with_dest(e, "copyfile", from, to))?;
        #[cfg(target_os = "wasi")]
        if let Some(perms) = src_mode {
            record_path_mode(&st, to, perms, false);
        }
        #[cfg(not(target_os = "wasi"))]
        let _ = &st;
        ok()
    });
    t.add("realpath", |a| {
        let path = required_path(a.str(0)?, "realpath")?;
        let real = crate::host::realpath(path).map_err(|e| io_error(e, "realpath", Some(path)))?;
        Ok(real.into())
    });
    t.add("readlink", |a| {
        let path = required_path(a.str(0)?, "readlink")?;
        let target = fs::read_link(path).map_err(|e| io_error(e, "readlink", Some(path)))?;
        Ok(target.to_string_lossy().into_owned().into())
    });
    t.add("symlink", |a| {
        let (target, path) = (a.str(0)?, required_path(a.str(1)?, "symlink")?);
        symlink(target, path).map_err(|e| io_error(e, "symlink", Some(path)))?;
        ok()
    });
    t.add("link", |a| {
        let (from, to) = (a.str(0)?, a.str(1)?);
        required_path(from, "link")?;
        required_path(to, "link")?;
        fs::hard_link(from, to).map_err(|e| io_error(e, "link", Some(from)))?;
        ok()
    });
    t.add("truncate", |a| {
        let path = required_path(a.str(0)?, "open")?;
        let file = OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|e| io_error(e, "open", Some(path)))?;
        file.set_len(a.opt_num(1).unwrap_or(0.0) as u64)
            .map_err(|e| io_error(e, "ftruncate", Some(path)))?;
        ok()
    });
    t.add("utimes", |a| {
        let follow = !a.bool(5);
        let syscall = if follow { "utime" } else { "lutime" };
        let path = required_path(a.str(0)?, syscall)?;
        file_times::set_path(path, &file_times::times(&a, 1)?, follow)
            .map_err(|e| io_error(e, syscall, Some(path)))?;
        ok()
    });
    t.add("futimes", |a| {
        file_times::set_descriptor(a.i32(0)?, &file_times::times(&a, 1)?)
            .map_err(|e| io_error(e, "futime", None))?;
        ok()
    });
}

mod file_times;

#[cfg(target_os = "wasi")]
pub(crate) fn symlink(target: &str, path: &str) -> io::Result<()> {
    std::os::wasi::fs::symlink_path(target, path)
}

#[cfg(unix)]
pub(crate) fn symlink(target: &str, path: &str) -> io::Result<()> {
    std::os::unix::fs::symlink(target, path)
}

#[cfg(not(any(unix, target_os = "wasi")))]
pub(crate) fn symlink(_: &str, _: &str) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

fn writev(state: &State, args: Args<'_>) -> NativeResult {
    let fd = match args.get(0) {
        Val::Num(n)
            if n.fract() == 0.0 && *n >= f64::from(i32::MIN) && *n <= f64::from(i32::MAX) =>
        {
            *n as i32
        }
        Val::Num(_) => {
            return Err(
                NativeError::range_error("fd must be a signed 32-bit integer")
                    .prop("code", "ERR_OUT_OF_RANGE"),
            );
        }
        _ => {
            return Err(
                NativeError::type_error("fd must be a number").prop("code", "ERR_INVALID_ARG_TYPE")
            );
        }
    };
    let buffers = args
        .array(1)
        .ok_or_else(|| NativeError::type_error("expected an array of byte buffers"))?;
    let buffers = buffers
        .iter()
        .map(|value| match value {
            Val::Bytes(bytes) => Ok(bytes.as_slice()),
            _ => Err(NativeError::type_error("expected a byte buffer")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    // Inherited descriptors can alias either output stream. Flush before every
    // direct write, not only writes whose descriptor number is 1 or 2.
    flush_descriptor_output(state).map_err(|e| io_error(e, "writev", None))?;
    if buffers.iter().all(|bytes| bytes.is_empty()) {
        return write_chunk(fd, &[], None)
            .map(|n| Val::Num(n as f64))
            .map_err(|e| io_error(e, "writev", None));
    }
    let descriptor = fd;
    let position = args
        .opt_num(2)
        .filter(|&n| n >= 0.0)
        .map(|n| n as libc::off_t);
    let mut written = 0usize;
    for bytes in buffers {
        if bytes.is_empty() {
            continue;
        }
        let offset = position
            .map(|base| {
                base.checked_add(written as libc::off_t)
                    .ok_or(io::ErrorKind::InvalidInput)
            })
            .transpose()
            .map_err(io::Error::from);
        let count = match offset.and_then(|offset| write_chunk(descriptor, bytes, offset)) {
            Ok(count) => count,
            Err(_) if written > 0 => break,
            Err(error) => return Err(io_error(error, "writev", None)),
        };
        written += count;
        if count < bytes.len() {
            break;
        }
    }
    synchronize_descriptor(state, descriptor, written).map_err(|e| io_error(e, "writev", None))?;
    Ok(Val::Num(written as f64))
}

fn flush_descriptor_output(state: &State) -> io::Result<()> {
    let fds = state.fds.borrow();
    let flush_out = fds.is_stdio_attached(1);
    let flush_err = fds.is_stdio_attached(2);
    drop(fds);
    if flush_out {
        state.flush_stdout()?;
    }
    if flush_err {
        io::stderr().flush()?;
    }
    Ok(())
}

fn retry_interrupted(mut operation: impl FnMut() -> io::Result<usize>) -> io::Result<usize> {
    loop {
        match operation() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => return result,
        }
    }
}

fn write_once(fd: libc::c_int, bytes: &[u8], position: Option<libc::off_t>) -> io::Result<usize> {
    // The argument frame owns these bytes until the synchronous call returns.
    let written = match position {
        Some(position) => unsafe { libc::pwrite(fd, bytes.as_ptr().cast(), bytes.len(), position) },
        None => unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) },
    };
    if written < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(written as usize)
}

fn write_chunk(fd: libc::c_int, bytes: &[u8], position: Option<libc::off_t>) -> io::Result<usize> {
    retry_interrupted(|| write_once(fd, bytes, position))
}

// Preserve committed progress when a later chunk fails. The initial empty syscall
// is deliberate: even zero-byte writes must validate their descriptor.
fn write_chunks_with(
    bytes: &[u8],
    position: Option<libc::off_t>,
    mut write: impl FnMut(&[u8], Option<libc::off_t>) -> io::Result<usize>,
) -> io::Result<usize> {
    let mut written = 0;
    loop {
        let offset = position
            .map(|base| {
                base.checked_add(written as libc::off_t)
                    .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))
            })
            .transpose();
        let result =
            offset.and_then(|offset| retry_interrupted(|| write(&bytes[written..], offset)));
        match result {
            Ok(0) if written == bytes.len() => return Ok(written),
            Ok(0) if written == 0 => return Err(io::ErrorKind::WriteZero.into()),
            Ok(0) => return Ok(written),
            Ok(count) => written += count,
            Err(_) if written > 0 => return Ok(written),
            Err(error) => return Err(error),
        }
        if written == bytes.len() {
            return Ok(written);
        }
    }
}

fn write_descriptor(state: &State, args: Args<'_>) -> NativeResult {
    let fd = args.i32(0)?;
    let bytes = args.bytes(1)?;
    if bytes.is_empty() {
        return write_chunk(fd, bytes, None)
            .map(|n| Val::Num(n as f64))
            .map_err(|e| io_error(e, "write", None));
    }
    if fd == 1 && state.fds.borrow().is_stdio_attached(1) {
        state
            .write_stdout(bytes)
            .map_err(|e| io_error(e, "write", None))?;
        return Ok(Val::Num(bytes.len() as f64));
    }
    if fd == 2 && state.fds.borrow().is_stdio_attached(2) {
        state
            .write_stderr(bytes)
            .map_err(|e| io_error(e, "write", None))?;
        return Ok(Val::Num(bytes.len() as f64));
    }
    flush_descriptor_output(state).map_err(|e| io_error(e, "write", None))?;
    let position = args
        .opt_num(2)
        .filter(|p| *p >= 0.0)
        .map(|p| p as libc::off_t);
    let written = write_chunks_with(bytes, position, |bytes, offset| {
        write_chunk(fd, bytes, offset)
    })
    .map_err(|e| io_error(e, "write", None))?;
    synchronize_descriptor(state, fd, written).map_err(|e| io_error(e, "write", None))?;
    Ok(Val::Num(written as f64))
}

fn close_descriptor(state: &State, args: Args<'_>) -> NativeResult {
    let fd = args.i32(0)?;
    if fd == 1 && state.fds.borrow().is_stdio_attached(1) {
        let _ = state.flush_stdout();
    } else if fd == 2 && state.fds.borrow().is_stdio_attached(2) {
        let _ = io::stderr().flush();
    }
    let mut fds = state.fds.borrow_mut();
    fds.detach_stdio(fd);
    fds.sync_modes.remove(&fd);
    if fds.files.remove(&fd).is_some() {
        return ok();
    }
    drop(fds);
    if unsafe { libc::close(fd) } < 0 {
        return Err(io_error(io::Error::last_os_error(), "close", None));
    }
    ok()
}

mod descriptor_read;

#[cfg(all(test, unix, feature = "engine-split"))]
mod io_copy_tests;

fn read_descriptor(args: Args<'_>) -> NativeResult {
    let fd = args.i32(0)?;
    let length = args.num(1)? as usize;
    let position = args
        .opt_num(2)
        .filter(|p| *p >= 0.0)
        .map(|p| p as libc::off_t);
    // Positional reads must not advance the shared open-file cursor.
    descriptor_read::read(fd, length, position)
        .map(Val::Bytes)
        .map_err(|e| io_error(e, "read", None))
}

fn install_fds(t: &mut Table, state: &Rc<State>) {
    let st = state.clone();
    t.add("open", move |a| {
        let path = a.str(0)?;
        let flags = a.i32(1)?;
        let mode = a.opt_num(2).unwrap_or(438.0) as u32;
        #[cfg(target_os = "wasi")]
        let umask = a.opt_num(3).unwrap_or(18.0) as u32;
        #[cfg(target_os = "wasi")]
        let existed = flags & 64 != 0 && fs::symlink_metadata(path).is_ok();
        let file = open_file(path, flags, mode).map_err(|e| io_error(e, "open", Some(path)))?;
        let fd = file.as_raw_fd();
        #[cfg(target_os = "wasi")]
        if flags & 64 != 0
            && !existed
            && let Ok(stat) = descriptor_metadata(fd)
        {
            record_inode_mode(&st, &stat, mask_creation_mode(mode, umask));
        }
        let mut fds = st.fds.borrow_mut();
        fds.files.insert(fd, file);
        fds.sync_modes.insert(fd, sync_mode(flags));
        Ok(fd.into())
    });
    let st = state.clone();
    t.add("close", move |a| close_descriptor(&st, a));
    t.add("read", read_descriptor);
    t.add("seek", |a| {
        let result = unsafe { libc::lseek(a.i32(0)?, a.num(1)? as libc::off_t, libc::SEEK_SET) };
        if result < 0 {
            return Err(io_error(io::Error::last_os_error(), "seek", None));
        }
        ok()
    });
    let st = state.clone();
    t.add("write", move |a| write_descriptor(&st, a));
    let st = state.clone();
    t.add("writev", move |a| writev(&st, a));
    let st = state.clone();
    t.add("fstat", move |a| {
        descriptor_stat(&st, a.i32(0)?, a.bool(1)).map_err(|e| io_error(e, "fstat", None))
    });
    t.add("ftruncate", |a| {
        let result =
            unsafe { libc::ftruncate(a.i32(0)?, a.opt_num(1).unwrap_or(0.0) as libc::off_t) };
        if result < 0 {
            return Err(io_error(io::Error::last_os_error(), "ftruncate", None));
        }
        ok()
    });
    let st = state.clone();
    t.add("fsync", move |a| {
        let fd = a.i32(0)?;
        sync_explicit_fd(&st, fd, SyncMode::All).map_err(|e| io_error(e, "fsync", None))?;
        ok()
    });
    let st = state.clone();
    t.add("fdatasync", move |a| {
        let fd = a.i32(0)?;
        sync_explicit_fd(&st, fd, SyncMode::Data)
            .map_err(|e| io_error(e, "fdatasync", None).prop("fd", fd))?;
        ok()
    });
}

fn builtin_index(args: Args<'_>) -> Result<usize, NativeError> {
    match args.get(0) {
        Val::Num(n) if *n >= 0.0 && n.fract() == 0.0 && *n <= u32::MAX as f64 => Ok(*n as usize),
        _ => Err(NativeError::type_error("expected a builtin registry index")),
    }
}

fn install_modules(t: &mut Table, state: &Rc<State>) {
    t.add("bunBuiltinNames", |_| {
        Ok(Val::Array(
            modules::BUN_BUILTIN_NAMES
                .iter()
                .map(|name| Val::from(*name))
                .collect(),
        ))
    });
    t.add("bunBuiltinSource", |a| {
        Ok(modules::bun_builtin_source(builtin_index(a)?)
            .map(Val::from)
            .into())
    });
    t.add("bunBuiltinHookName", |a| {
        Ok(modules::BUN_BUILTIN_HOOK_NAMES
            .get(builtin_index(a)?)
            .copied()
            .unwrap_or("unknown")
            .into())
    });
    t.add("bunBuiltinErrorCode", |a| {
        Ok(modules::BUN_BUILTIN_ERROR_CODES
            .get(builtin_index(a)?)
            .copied()
            .unwrap_or("unknown")
            .into())
    });
    let st = state.clone();
    t.add("transpilePublic", move |a| {
        st.transpiler
            .public_transpile(a.bytes(0)?, a.str(1)?, a.str(2)?, a.str(3)?)
            .map(Val::from)
            .map_err(NativeError::syntax_error)
    });
    let st = state.clone();
    t.add("prepareSource", move |a| {
        st.transpiler
            .prepare_source(a.str(0)?, a.str(1)?)
            .map(Val::from)
            .map_err(NativeError::syntax_error)
    });
    let st = state.clone();
    t.add("prepareFunction", move |a| {
        let args = a
            .array(0)
            .ok_or_else(|| NativeError::type_error("expected function arguments"))?;
        let strings = args
            .iter()
            .map(|value| match value {
                Val::Str(value) => Ok(value.clone()),
                _ => Err(NativeError::type_error("expected source string")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        st.transpiler
            .prepare_function(&strings, a.str(1)?, a.bool(2))
            .map(Val::from)
            .map_err(NativeError::syntax_error)
    });
    let st = state.clone();
    t.add("registerObjectModule", move |a| {
        Ok(st.resolver.register_object_module(a.str(0)?).into())
    });
    let st = state.clone();
    t.add("mockModule", move |a| {
        Ok(st.resolver.register_mock(a.str(0)?, a.str(1)?).into())
    });
    let st = state.clone();
    t.add("mockTarget", move |a| {
        Ok(st
            .resolver
            .mock_target(a.str(0)?)
            .map_or(Val::Undefined, Val::Str))
    });
    let st = state.clone();
    t.add("clearObjectModules", move |_| {
        st.resolver.clear_object_modules();
        Ok(Val::Undefined)
    });
    let st = state.clone();
    t.add("resolve", move |a| {
        let spec = a.str(0)?;
        let kind = if a.bool(2) {
            Kind::Require
        } else {
            Kind::Import
        };
        match st.resolver.resolve(spec, a.str(1)?, kind) {
            Ok(Resolved::Builtin(name)) => Ok(name.into()),
            Ok(Resolved::File(path)) => Ok(path.into()),
            Err(msg) => Err(crate::modules::resolve_error(
                &msg,
                spec,
                a.str(1)?,
                kind,
                st.resolver.notes(),
            )),
        }
    });
    let st = state.clone();
    t.add("resolveImport", move |a| {
        use crate::import_requests::{ImportMode, ImportRequest};
        let mode = match a.str(2)? {
            "inferred" => ImportMode::Inferred,
            "text" => ImportMode::Text,
            _ => return Err(NativeError::type_error("Invalid import mode")),
        };
        let name = st.resolve_import(
            ImportRequest {
                specifier: a.str(0)?,
                mode,
            },
            a.str(1)?,
        )?;
        Ok(name.as_str().into())
    });
    let st = state.clone();
    t.add("modulePath", move |a| Ok(st.module_path(a.str(0)?).into()));
    let st = state.clone();
    t.add("workerSource", move |a| {
        let path = a.str(1)?;
        st.transpiler
            .transpile(a.str(0)?, path, crate::transpiler::Loader::from_path(path))
            .map(Val::from)
            .map_err(NativeError::syntax_error)
    });
    let st = state.clone();
    t.add("hotPrepare", move |a| {
        let generation = a.num(0)?;
        if generation.fract() != 0.0 || !(1.0..=f64::from(u32::MAX)).contains(&generation) {
            return Err(NativeError::type_error("Invalid hot generation"));
        }
        st.prepare_hot(generation as u32, a.str(1)?)
    });
    let st = state.clone();
    t.add("hotDigest", move |a| {
        st.hot_digest(a.str(0)?).map(Val::from)
    });
    t.add("hotMapPosition", move |a| {
        Ok(crate::hot_run::map_position(
            a.opt_str(0),
            a.opt_str(1),
            a.u32(2)?,
            a.u32(3)?,
            a.u32(4)?,
            a.u32(5)?,
        ))
    });
    let st = state.clone();
    t.add("moduleFormat", move |a| {
        Ok(st.probe_source(a.str(0)?)?.1.name().into())
    });
    let st = state.clone();
    t.add("mapPosition", move |a| {
        let mapped = st.map_position(a.str(0)?, a.u32(1)?, a.u32(2)?);
        Ok(mapped.map_or(Val::Undefined, |(l, c)| {
            Val::Array(vec![l.into(), c.into()])
        }))
    });
    let st = state.clone();
    t.add("sourceGeneration", move |_| {
        Ok(st.source_generation().into())
    });
    let st = state.clone();
    t.add("getSourceLine", move |a| {
        Ok(st.source_line(a.str(0)?, a.num(1)? as usize).into())
    });
    // inspect.js's stack-frame column rules, applied to the stored line so a minified
    // bundle's line never crosses into the engine per frame (crate::source_column).
    let st = state.clone();
    t.add("sourceColumn", move |a| {
        let rule = crate::source_column::Rule::parse(a.str(0)?)
            .ok_or_else(|| NativeError::type_error("Unknown source column rule"))?;
        let column = a.num(3)?;
        if !(column >= 1.0 && column.fract() == 0.0 && column <= u32::MAX as f64) {
            return Ok(column.into());
        }
        let mapped = st.source_column(rule, a.str(1)?, a.num(2)? as usize, column as usize);
        Ok((mapped as f64).into())
    });
    // `Bun.build`: the options as JSON (src/js/bun.js normalizes them), the
    // outputs as `{ outputs: [{ path, kind, contents }], logs }`.
    let st = state.clone();
    t.add("build", move |a| {
        let request = build_request(a.str(0)?)?;
        let result = st
            .transpiler
            .build(&request)
            .map_err(|log| NativeError::error(log).prop("code", "BUILD_FAILED"))?;
        let outputs = result
            .outputs
            .into_iter()
            .map(|o| {
                Record::new()
                    .set("path", o.path)
                    .set("kind", o.kind)
                    .set("contents", Val::Bytes(o.contents))
                    .into()
            })
            .collect();
        Ok(Record::new()
            .set("outputs", Val::Array(outputs))
            .set("logs", result.logs)
            .into())
    });
    // `Bun.color` (js/bun_color.ts reads JavaScript inputs): (format, CSS text) or
    // (format, undefined, r, g, b, a).
    let st = state.clone();
    t.add("color", move |a| {
        use crate::{ColorInput, ColorValue};
        let input = match a.opt_bytes(1) {
            Some(text) => ColorInput::Css(text),
            None => ColorInput::Rgba([
                a.num(2)? as u8,
                a.num(3)? as u8,
                a.num(4)? as u8,
                a.num(5)? as u8,
            ]),
        };
        Ok(
            match st
                .transpiler
                .color(input, a.str(0)?)
                .map_err(NativeError::type_error)?
            {
                ColorValue::Null => Val::Null,
                ColorValue::Text(text) => Val::Str(text),
                ColorValue::Number(number) => Val::Num(number),
                ColorValue::Array(items) => Val::Array(items.into_iter().map(Val::Num).collect()),
                ColorValue::Object(fields) => fields
                    .into_iter()
                    .fold(Record::new(), |record, (key, value)| record.set(key, value))
                    .into(),
            },
        )
    });
    // `Bun.markdown.html`/`.ansi` (js/bun_markdown.ts reads the options): (mode, text, options JSON).
    let st = state.clone();
    t.add("markdown", move |a| {
        let options: serde_json::Value = serde_json::from_str(a.str(2)?)
            .map_err(|error| NativeError::type_error(error.to_string()))?;
        let flag = |key: &str| options.get(key).and_then(serde_json::Value::as_bool);
        let flags = options
            .get("flags")
            .and_then(serde_json::Value::as_object)
            .map(|fields| {
                fields
                    .iter()
                    .filter_map(|(name, value)| value.as_bool().map(|value| (name.clone(), value)))
                    .collect()
            })
            .unwrap_or_default();
        let request = crate::MarkdownRequest {
            text: a.bytes(1)?,
            ansi: a.str(0)? == "ansi",
            flags,
            colors: flag("colors"),
            hyperlinks: flag("hyperlinks"),
            kitty_graphics: flag("kittyGraphics"),
            light: flag("light"),
            columns: options
                .get("columns")
                .and_then(serde_json::Value::as_u64)
                .map(|columns| columns.min(u64::from(u16::MAX)) as u16),
        };
        let out = st
            .transpiler
            .markdown(&request)
            .map_err(NativeError::error)?;
        Ok(Val::Str(String::from_utf8_lossy(&out).into_owned()))
    });
    let st = state.clone();
    t.add("devServerOpen", move |a| {
        st.transpiler
            .dev_server_open(a.str(0)?)
            .map(dev_server_record)
            .map_err(NativeError::error)
    });
    let st = state.clone();
    t.add("devServerRebuild", move |a| {
        let changed: Vec<String> = serde_json::from_str(a.str(1)?)
            .map_err(|error| NativeError::type_error(error.to_string()))?;
        st.transpiler
            .dev_server_rebuild(a.u32(0)?, &changed)
            .map(dev_server_record)
            .map_err(NativeError::error)
    });
    let st = state.clone();
    t.add("devServerClose", move |a| {
        st.transpiler.dev_server_close(a.u32(0)?);
        ok()
    });
}

fn dev_server_record(result: crate::DevServerResult) -> Val {
    let files = result
        .files
        .into_iter()
        .map(|file| {
            Record::new()
                .set("path", file.path)
                .set("contents", Val::Bytes(file.contents))
                .set("type", file.mime)
                .into()
        })
        .collect();
    Record::new()
        .set("id", result.id)
        .set("version", result.version)
        .set("html", Val::Bytes(result.html))
        .set("files", Val::Array(files))
        .set(
            "watch",
            Val::Array(result.watch.into_iter().map(Val::Str).collect()),
        )
        .set("update", Val::Bytes(result.update))
        .set("errors", Val::Bytes(result.errors))
        .set("logs", result.logs)
        .into()
}

fn build_request(json: &str) -> Result<crate::BuildRequest, NativeError> {
    use serde_json::Value as Json;
    let v: Json = serde_json::from_str(json)
        .map_err(|e| NativeError::type_error(format!("Bun.build: {e}")))?;
    let text = |k: &str| v.get(k).and_then(Json::as_str).map(str::to_owned);
    let flag = |k: &str| v.get(k).and_then(Json::as_bool).unwrap_or(false);
    let list = |k: &str| -> Vec<String> {
        v.get(k)
            .and_then(Json::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    let define = v
        .get("define")
        .and_then(Json::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, x)| x.as_str().map(|x| (k.clone(), x.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    Ok(crate::BuildRequest {
        entrypoints: list("entrypoints"),
        outdir: text("outdir"),
        root: text("root"),
        target: text("target"),
        format: text("format"),
        splitting: flag("splitting"),
        external: list("external"),
        packages: text("packages"),
        define,
        conditions: list("conditions"),
        minify_syntax: flag("minifySyntax"),
        minify_whitespace: flag("minifyWhitespace"),
        minify_identifiers: flag("minifyIdentifiers"),
        sourcemap: text("sourcemap"),
        public_path: text("publicPath"),
        entry_naming: text("entryNaming"),
        chunk_naming: text("chunkNaming"),
        asset_naming: text("assetNaming"),
        banner: text("banner"),
        footer: text("footer"),
        react_fast_refresh: flag("reactFastRefresh"),
    })
}

fn install_encoding(t: &mut Table) {
    // Bun's interned MIME type for an exact name, or undefined (src/mime_types.rs).
    t.add("mimeTypeInterned", |a| {
        Ok(crate::mime_types::interned(a.str(0)?).map_or(Val::Undefined, Into::into))
    });
    t.add("utf8Encode", |a| {
        Ok(Val::Bytes(a.str(0)?.as_bytes().to_vec()))
    });
    t.add("utf8Decode", |a| {
        let bytes = a.bytes(0)?;
        match std::str::from_utf8(bytes) {
            Ok(s) => Ok(s.into()),
            Err(_) if a.bool(1) => Err(NativeError::type_error(
                "The encoded data was not valid for encoding utf-8",
            )
            .prop("code", "ERR_ENCODING_INVALID_ENCODED_DATA")),
            Err(_) => Ok(String::from_utf8_lossy(bytes).into_owned().into()),
        }
    });
    t.add("latin1Decode", |a| {
        Ok(a.bytes(0)?
            .iter()
            .map(|&b| char::from(b))
            .collect::<String>()
            .into())
    });
    t.add("utf16leDecode", |a| {
        let units: Vec<u16> = a
            .bytes(0)?
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        Ok(String::from_utf16_lossy(&units).into())
    });
    t.add("base64Encode", |a| {
        Ok(crate::encoding::base64_encode(a.bytes(0)?, a.bool(1)).into())
    });
    t.add("base64Decode", |a| {
        Ok(Val::Bytes(crate::encoding::base64_decode(a.str(0)?)))
    });
}

fn install_crypto(t: &mut Table) {
    t.add("timingSafeEqual", |a| {
        use subtle::ConstantTimeEq;
        Ok(Val::Bool(bool::from(a.bytes(0)?.ct_eq(a.bytes(1)?))))
    });
    t.add("cryptoOp", |a| Ok(crate::crypto::request(a.str(0)?).into()));
    t.add("randomBytes", |a| {
        let mut buf = vec![0u8; a.num(0)? as usize];
        getrandom::fill(&mut buf).map_err(|e| NativeError::error(e.to_string()))?;
        Ok(Val::Bytes(buf))
    });
    t.add("hash", |a| {
        let alg = a.str(0)?;
        let digest = crate::encoding::digest(alg, a.bytes(1)?).ok_or_else(|| {
            NativeError::type_error(format!("Digest method not supported: {alg}"))
        })?;
        Ok(Val::Bytes(digest))
    });
    t.add("hmac", |a| {
        let alg = a.str(0)?;
        let digest = crate::encoding::hmac(alg, a.bytes(1)?, a.bytes(2)?)
            .ok_or_else(|| NativeError::type_error(format!("Invalid digest: {alg}")))?;
        Ok(Val::Bytes(digest))
    });
    // node:crypto and Bun.CryptoHasher: (canonical name, data, output length).
    t.add("nodeDigest", |a| {
        use crate::node_digest::{DigestError, digest};
        let alg = a.str(0)?;
        let output_len = a.opt_num(2).map(|len| len as usize);
        match digest(alg, &[a.bytes(1)?], output_len) {
            Ok(out) => Ok(Val::Bytes(out)),
            Err(DigestError::Unsupported) => Err(NativeError::type_error(format!(
                "Digest method not supported: {alg}"
            ))),
            Err(DigestError::NotXof) => {
                Err(NativeError::error("NOT_XOF_OR_INVALID_LENGTH".to_string()))
            }
            Err(DigestError::OutOfMemory) => Err(NativeError::range_error("Out of memory")),
        }
    });
    // Bun.password (js/bun_password.ts validates the arguments): (password, algorithm, cost,
    // memoryCost, timeCost) and (password, hash, algorithm?).
    t.add("passwordHash", |a| {
        use crate::password::{Algorithm, Params, hash};
        let algorithm = Algorithm::parse(a.str(1)?)
            .ok_or_else(|| NativeError::type_error("unknown password algorithm".to_string()))?;
        let params = Params {
            algorithm,
            cost: a.num(2)? as u32,
            memory_cost: a.num(3)? as u32,
            time_cost: a.num(4)? as u32,
        };
        hash(a.bytes(0)?, params)
            .map(Val::Str)
            .map_err(|err| password_error(err, "hashing"))
    });
    t.add("passwordVerify", |a| {
        use crate::password::{Algorithm, verify};
        let algorithm = match a.opt_str(2) {
            Some(name) => Some(Algorithm::parse(name).ok_or_else(|| {
                NativeError::type_error("unknown password algorithm".to_string())
            })?),
            None => None,
        };
        verify(a.bytes(0)?, a.bytes(1)?, algorithm)
            .map(Val::Bool)
            .map_err(|err| password_error(err, "verification"))
    });
    // Bun.CSRF (js/bun_csrf.ts validates the options): (algorithm, format, expiresIn ms,
    // secret?, sessionId?) and (token, algorithm, format, maxAge ms, secret?, sessionId?).
    t.add("csrfGenerate", |a| {
        let format = crate::csrf::TokenFormat::parse(a.str(1)?)
            .ok_or_else(|| NativeError::type_error("Invalid format".to_string()))?;
        crate::csrf::generate(
            a.opt_bytes(3),
            a.opt_bytes(4).unwrap_or(&[]),
            a.num(2)? as u64,
            a.str(0)?,
            format,
        )
        .map(Val::Str)
        .map_err(csrf_error)
    });
    t.add("csrfVerify", |a| {
        let format = crate::csrf::TokenFormat::parse(a.str(2)?)
            .ok_or_else(|| NativeError::type_error("Invalid format".to_string()))?;
        crate::csrf::verify(
            a.bytes(0)?,
            a.opt_bytes(4),
            a.opt_bytes(5).unwrap_or(&[]),
            a.num(3)? as u64,
            a.str(1)?,
            format,
        )
        .map(Val::Bool)
        .map_err(csrf_error)
    });
    // node:crypto pbkdf2: (canonical name, password, salt, iterations, keylen).
    t.add("nodePbkdf2", |a| {
        use crate::node_digest::{DigestError, pbkdf2};
        let alg = a.str(0)?;
        match pbkdf2(
            alg,
            a.bytes(1)?,
            a.bytes(2)?,
            a.num(3)? as u32,
            a.num(4)? as usize,
        ) {
            Ok(out) => Ok(Val::Bytes(out)),
            Err(DigestError::OutOfMemory) => Err(NativeError::range_error("Out of memory")),
            Err(_) => Err(NativeError::type_error(format!("Invalid digest: {alg}"))),
        }
    });
    t.add("nodeHmac", |a| {
        let alg = a.str(0)?;
        let digest = crate::node_digest::hmac(alg, a.bytes(1)?, a.bytes(2)?)
            .ok_or_else(|| NativeError::type_error(format!("Invalid digest: {alg}")))?;
        Ok(Val::Bytes(digest))
    });
    // Bun.hash.cityHash32 and friends: (algorithm, data, seed high 32 bits, seed low 32 bits).
    t.add("bunHash", |a| {
        use crate::bun_hash::{Output, hash};
        let name = a.str(0)?;
        let seed = ((a.num(2)? as u64) << 32) | a.num(3)? as u64;
        match hash(name, a.bytes(1)?, seed) {
            Some(Output::U32(n)) => Ok(Val::Num(f64::from(n))),
            Some(Output::U64(n)) => Ok(Val::BigUint(n)),
            None => Err(NativeError::type_error(format!(
                "Unknown hash algorithm: {name}"
            ))),
        }
    });
    t.add("wyhash", |a| {
        // Bun.hash: (data, seed high 32 bits, seed low 32 bits).
        let seed =
            ((a.opt_num(1).unwrap_or(0.0) as u64) << 32) | a.opt_num(2).unwrap_or(0.0) as u64;
        Ok(Val::BigUint(bun_wyhash::hash_with_seed(seed, a.bytes(0)?)))
    });
    // node:zlib's processChunkSync for the sync and callback convenience
    // functions and Bun.gzipSync/deflateSync: (data, mode, options JSON,
    // dictionary, flush, chunkSize, maxOutputLength).
    t.add("zlibConvert", |a| {
        use crate::compression::{Mode, Options, convert};
        let mode = Mode::parse(a.str(1)?)?;
        let options = Options::parse(a.opt_str(2), a.opt_bytes(3).unwrap_or(&[]))?;
        let flush = a.opt_num(4).map_or(mode.finish_flush(), |n| n as i32);
        let chunk = a.opt_num(5).unwrap_or(16384.0) as usize;
        let limit = a.opt_num(6).unwrap_or(f64::MAX) as usize;
        convert(mode, &options, a.bytes(0)?, flush, chunk, limit).map(Val::Bytes)
    });
    // Bun.zstdCompressSync/zstdDecompressSync use Bun's own one-shot Zstd calls
    // (src/runtime/api/BunObject.rs, JSZstd).
    t.add("zstdCompress", |a| {
        let input = a.bytes(0)?;
        let bound = bun_zstd::compress_bound(input.len());
        if bun_zstd::is_error(bound) {
            return Err(
                NativeError::error("Input is too large to compress").prop("code", "ERR_ZSTD")
            );
        }
        let mut output = Vec::new();
        output
            .try_reserve_exact(bound)
            .map_err(|_| crate::compression::out_of_memory())?;
        if let bun_zstd::Result::Err(error) =
            bun_zstd::compress_append(&mut output, input, Some(a.i32(1)?))
        {
            let message = String::from_utf8_lossy(error.as_bytes()).into_owned();
            return Err(NativeError::error(message).prop("code", "ERR_ZSTD"));
        }
        Ok(Val::Bytes(output))
    });
    t.add("zstdDecompress", |a| {
        match bun_zstd::decompress_alloc(a.bytes(0)?) {
            Ok(output) => Ok(Val::Bytes(output)),
            Err(bun_zstd::ZstdError::OutOfMemory) => Err(crate::compression::out_of_memory()),
            Err(error) => {
                let name: &'static str = error.into();
                Err(NativeError::error(format!("Decompression failed: {name}"))
                    .prop("code", "ERR_ZSTD"))
            }
        }
    });
    t.add("crc32", |a| {
        Ok(Val::Num(f64::from(crate::encoding::crc32_seed(
            a.bytes(0)?,
            a.opt_num(1).unwrap_or(0.0) as u32,
        ))))
    });
    t.add("adler32", |a| {
        Ok(Val::Num(f64::from(crate::encoding::adler32(a.bytes(0)?))))
    });
}

/// URL components in the order the JS `URL` class expects.
fn url_parts(url: &url::Url) -> Val {
    let parts = [
        url.as_str().to_owned(),
        format!("{}:", url.scheme()),
        url.username().to_owned(),
        url.password().unwrap_or("").to_owned(),
        url.host_str().unwrap_or("").to_owned(),
        url.port().map(|p| p.to_string()).unwrap_or_default(),
        url.path().to_owned(),
        url.query()
            .filter(|q| !q.is_empty())
            .map(|q| format!("?{q}"))
            .unwrap_or_default(),
        url.fragment()
            .filter(|f| !f.is_empty())
            .map(|f| format!("#{f}"))
            .unwrap_or_default(),
        url.origin().ascii_serialization(),
    ];
    Val::Array(parts.into_iter().map(Val::Str).collect())
}

fn install_url(t: &mut Table) {
    t.add("urlParse", |a| {
        let input = a.str(0)?;
        let parsed = match a.opt_str(1) {
            Some(base) => url::Url::parse(base).and_then(|b| b.join(input)),
            None => url::Url::parse(input),
        };
        Ok(parsed.ok().map_or(Val::Undefined, |u| url_parts(&u)))
    });
    t.add("urlSet", |a| {
        let Ok(mut url) = url::Url::parse(a.str(0)?) else {
            return ok();
        };
        let value = a.str(2)?;
        // Setters that fail leave the URL unchanged, like the WHATWG spec says.
        let _ = match a.str(1)? {
            "protocol" => url.set_scheme(value.trim_end_matches(':')),
            "username" => url.set_username(value),
            "password" => url.set_password(Some(value).filter(|v| !v.is_empty())),
            "host" => url::quirks::set_host(&mut url, value),
            "hostname" => url::quirks::set_hostname(&mut url, value),
            "port" => url::quirks::set_port(&mut url, value),
            "pathname" => {
                url::quirks::set_pathname(&mut url, value);
                Ok(())
            }
            "search" => {
                url::quirks::set_search(&mut url, value);
                Ok(())
            }
            "hash" => {
                url::quirks::set_hash(&mut url, value);
                Ok(())
            }
            _ => Ok(()),
        };
        Ok(url_parts(&url))
    });
    t.add("domainToASCII", |a| {
        let host = url::Url::parse(&format!("http://{}/", a.str(0)?))
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default();
        Ok(host.into())
    });
    t.add("domainToUnicode", |a| {
        let mut url = url::Url::parse("http://domain.invalid/").expect("valid base URL");
        if url::quirks::set_hostname(&mut url, a.str(0)?).is_err() {
            return Ok("".into());
        }
        let domain = match url.host() {
            Some(url::Host::Domain(domain)) => url::quirks::domain_to_unicode(domain),
            Some(host) => host.to_string(),
            None => String::new(),
        };
        Ok(domain.into())
    });
}

/// The `bun_wasm` host ABI (docs/host-abi.md) for the JS networking layer
/// (src/js/net.js). Functions return the ABI's raw codes (negative = error);
/// byte results come back as Uint8Array / strings.
fn install_host(t: &mut Table, state: &Rc<State>) {
    use crate::host;
    // Slot capabilities, plus the process ABI and signals: runtime_proc is a wasm import namespace, not slots.
    let caps = host::SLOT_NAMES
        .iter()
        .enumerate()
        .map(|(i, name)| ((*name).to_owned(), Val::Bool(host::provided(i))))
        .chain(["proc_spawn", "signal"].map(|name| (name.to_owned(), Val::Bool(host::PROCESS_ABI))))
        .collect();
    t.constants.push(("hostCaps", Val::Object(caps)));
    // String on success, the negative code otherwise.
    fn text_or_code(result: Result<Vec<u8>, i32>) -> NativeResult {
        Ok(match result {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned().into(),
            Err(code) => code.into(),
        })
    }
    // runtime_proc process ABI (docs/host-abi.md, "Process imports"). Results are `>= 0` or a
    // negative WASI errno; byte results come back as Uint8Array.
    t.add("procAccess", |a| {
        Ok(host::proc_access(a.str(0)?, a.str(1)?).into())
    });
    t.add("procSpawn", |a| Ok(host::proc_spawn(a.bytes(0)?).into()));
    t.add("procSpawnError", |a| {
        text_or_code(host::proc_spawn_error(a.i32(0)?))
    });
    t.add("procJobOf", |a| Ok(host::proc_job_of(a.i32(0)?).into()));
    t.add("processIdentity", |_| {
        let pair = host::proc_identity().map_err(NativeError::error)?;
        Ok(Val::Array(pair.into_iter().map(Val::from).collect()))
    });
    t.add("procPipe", |_| {
        Ok(match host::proc_pipe() {
            Ok((read, write)) => Val::Array(vec![Val::Num(read as f64), Val::Num(write as f64)]),
            Err(code) => code.into(),
        })
    });
    t.add("procClose", |a| Ok(host::proc_close(a.i32(0)?).into()));
    // runtime_fs watches: ids and records for fs_watch.ts, failures as negative WASI errnos.
    t.add("fsWatchResolve", |a| {
        Ok(match host::fs_watch_resolve(a.str(0)?) {
            Ok((fd, identity)) => Val::Array(vec![
                Val::Num(fd as f64),
                Val::Str(identity.unwrap_or_default()),
            ]),
            Err(errno) => (-errno).into(),
        })
    });
    t.add("fsWatchOpenFd", |a| {
        Ok(match host::fs_watch_open_fd(a.i32(0)?, a.bool(1)) {
            Ok(id) => (id as f64).into(),
            Err(errno) => (-errno).into(),
        })
    });
    t.add("fsWatchDropFd", |a| {
        host::fs_watch_drop_fd(a.i32(0)?);
        Ok(Val::Undefined)
    });
    t.add("fsWatchOpen", |a| {
        Ok(match host::fs_watch_open(a.str(0)?, a.bool(1)) {
            Ok(id) => (id as f64).into(),
            Err(errno) => (-errno).into(),
        })
    });
    t.add("fsWatchReady", |_| Ok(host::fs_watch_ready().into()));
    t.add("fsWatchRead", |a| {
        let max_bytes = a
            .opt_num(1)
            .map(|n| n.clamp(0.0, 16.0 * 1024.0 * 1024.0) as usize);
        Ok(match host::fs_watch_read(a.u32(0)?, max_bytes) {
            Ok(bytes) if bytes.is_empty() => 0.into(),
            Ok(bytes) => Val::Bytes(bytes),
            Err(errno) => (-errno).into(),
        })
    });
    // `[id, records | 0 at end | -errno]` for the next ready watch, or a bare -errno (-6 EAGAIN).
    t.add("fsWatchNext", |_| {
        let (id, payload) = match host::fs_watch_next() {
            host::WatchNext::Records(id, bytes) if bytes.is_empty() => (id, 0.into()),
            host::WatchNext::Records(id, bytes) => (id, Val::Bytes(bytes)),
            host::WatchNext::WatchError(id, errno) => (id, (-errno).into()),
            host::WatchNext::Error(errno) => return Ok((-errno).into()),
        };
        Ok(Val::Array(vec![Val::Num(id as f64), payload]))
    });
    t.add("fsWatchClose", |a| {
        Ok((-host::fs_watch_close(a.u32(0)?)).into())
    });
    t.add("procRead", |a| {
        let cap = a
            .opt_num(1)
            .unwrap_or(65536.0)
            .clamp(1.0, 16.0 * 1024.0 * 1024.0) as usize;
        Ok(match host::proc_read(a.i32(0)?, cap) {
            Ok(bytes) if bytes.is_empty() => 0.into(),
            Ok(bytes) => Val::Bytes(bytes),
            Err(code) => code.into(),
        })
    });
    t.add("procWrite", |a| {
        Ok(host::proc_write(a.i32(0)?, a.bytes(1)?).into())
    });
    write_once_natives(t, host::proc_write);
    t.add("procWait", |a| {
        Ok(match host::proc_wait(a.i32(0)?) {
            Ok((kind, code)) => Val::Array(vec![Val::Num(kind as f64), Val::Num(code as f64)]),
            Err(code) => code.into(),
        })
    });
    t.add("procStartStatus", |a| {
        Ok(host::proc_start_status(a.i32(0)?).into())
    });
    t.add("procWaitJob", |a| {
        Ok(match host::proc_wait_job(a.i32(0)?, a.i32(1)?) {
            Ok((kind, code)) => Val::Array(vec![Val::Num(kind as f64), Val::Num(code as f64)]),
            Err(code) => code.into(),
        })
    });
    t.add("procKill", |a| {
        Ok(host::proc_kill(a.i32(0)?, a.i32(1)?).into())
    });
    t.add("procKillJob", |a| {
        Ok(host::proc_kill_job(a.i32(0)?, a.i32(1)?).into())
    });
    t.add("procProbeProcess", |a| {
        Ok(host::proc_probe_process(a.i32(0)?).into())
    });
    t.add("procPoll", |a| {
        Ok(match host::proc_poll(a.bytes(0)?, a.i32(1)?) {
            Ok(events) => Val::Bytes(events),
            Err(code) => code.into(),
        })
    });
    let st = state.clone();
    t.add("hostSignal", move |a| {
        Ok(st.signal(a.i32(0)?, a.i32(1)?).into())
    });
    t.add("hostPoll", |a| Ok(host::poll(a.i32(0)?).into()));
    t.add("hostFetch", |a| {
        let body = if a.is_missing(1) {
            &[][..]
        } else {
            a.bytes(1)?
        };
        Ok(host::fetch(a.str(0)?.as_bytes(), body).into())
    });
    t.add("hostFetchStream", |a| {
        Ok(host::fetch_stream(a.str(0)?.as_bytes()).into())
    });
    t.add("hostFetchHead", |a| {
        text_or_code(host::fetch_head(a.i32(0)?))
    });
    t.add("hostLookupStart", |a| {
        let family = a.i32(1)?;
        let hints = a.i32(2)?;
        Ok(host::lookup_start(a.str(0)?, family, hints).into())
    });
    t.add("hostLookupHead", |a| {
        text_or_code(host::lookup_head(a.i32(0)?))
    });
    t.add("hostError", |a| text_or_code(host::error(a.i32(0)?)));
    t.add("hostShutdown", |a| Ok(host::shutdown(a.i32(0)?).into()));
    t.add("hostLocalAddr", |a| {
        text_or_code(host::local_addr(a.i32(0)?))
    });
    t.add("hostPeerAddr", |a| text_or_code(host::peer_addr(a.i32(0)?)));
    t.add("hostRead", |a| {
        let cap = a.opt_num(1).unwrap_or(65536.0).max(1.0) as usize;
        Ok(match host::read(a.i32(0)?, cap) {
            Ok(bytes) if bytes.is_empty() => 0.into(),
            Ok(bytes) => Val::Bytes(bytes),
            Err(code) => code.into(),
        })
    });
    t.add("hostWrite", |a| {
        Ok(host::write(a.i32(0)?, a.bytes(1)?).into())
    });
    t.add("hostClose", |a| Ok(host::close(a.i32(0)?).into()));
    t.add("hostListen", |a| {
        Ok(host::listen(a.str(0)?, a.i32(1)?).into())
    });
    t.add("hostListenPath", |a| {
        Ok(host::listen_path(a.str(0)?, a.i32(1)?).into())
    });
    t.add("hostConnectPath", |a| {
        Ok(host::connect_path(a.str(0)?).into())
    });
    t.add("hostLocalPort", |a| Ok(host::local_port(a.i32(0)?).into()));
    t.add("hostAccept", |a| Ok(host::accept(a.i32(0)?).into()));
    t.add("hostConnect", |a| {
        Ok(host::connect(a.str(0)?, a.i32(1)?).into())
    });
}

fn platform_info() -> Val {
    Record::new()
        .set("version", crate::BUN_VERSION)
        .set("revision", crate::BUN_REVISION)
        .set(
            "arch",
            if cfg!(target_arch = "wasm32") {
                "wasm32"
            } else {
                std::env::consts::ARCH
            },
        )
        .into()
}

#[cfg(test)]
mod builtin_tests {
    use super::*;

    fn test_state() -> Rc<State> {
        Rc::new(State::new(Vec::new(), Box::new(PassthroughTranspiler)))
    }

    #[test]
    fn wasi_mode_masks_and_inode_clear_rules_match_linux_and_bun() {
        assert_eq!(mask_creation_mode(0o666, 0o022), 0o644);
        assert_eq!(mask_creation_mode(0o4777, 0o022), 0o4755);
        assert_eq!(mask_dir_creation_mode(0o1777, 0o022), 0o1755);
        assert_eq!(mask_dir_creation_mode(0o2777, 0o022), 0o755);
        assert_eq!(mask_dir_creation_mode(0o4777, 0o022), 0o755);
        assert_eq!(mask_dir_creation_mode(0o7777, 0o022), 0o1755);
        assert_eq!(mask_dir_creation_mode(0o700, 0), 0o700);
        // Hard-linked files stay recorded until every remaining link is removed.
        assert!(!should_clear_inode(false, 2, 1));
        assert!(should_clear_inode(false, 2, 2));
        assert!(should_clear_inode(false, 1, 1));
        // Directories always have nlink >= 2 and clear when removed.
        assert!(should_clear_inode(true, 2, 1));
    }

    #[test]
    fn filesystem_empty_paths_retain_operation_errors() {
        let mut natives = Table::default();
        install_fs(&mut natives, &test_state());
        for (name, syscall, args) in [
            ("readFile", "open", vec!["".into()]),
            ("readFileUtf8", "open", vec!["".into()]),
            ("stat", "stat", vec!["".into(), false.into()]),
            ("stat", "lstat", vec!["".into(), true.into()]),
            ("mkdir", "mkdir", vec!["".into(), false.into()]),
            ("mkdir", "mkdir", vec!["".into(), true.into()]),
            ("readdir", "scandir", vec!["".into()]),
            ("rm", "rm", vec!["".into()]),
            ("rmdir", "rmdir", vec!["".into()]),
            ("unlink", "unlink", vec!["".into()]),
            ("rename", "rename", vec!["".into(), ".".into()]),
            ("rename", "rename", vec![".".into(), "".into()]),
            ("copyFile", "copyfile", vec!["".into(), ".".into()]),
            ("copyFile", "copyfile", vec![".".into(), "".into()]),
            ("realpath", "realpath", vec!["".into()]),
            ("readlink", "readlink", vec!["".into()]),
            ("symlink", "symlink", vec!["target".into(), "".into()]),
            ("link", "link", vec!["".into(), ".".into()]),
            ("link", "link", vec![".".into(), "".into()]),
            ("truncate", "open", vec!["".into()]),
            ("writeFile", "open", vec!["".into(), "x".into()]),
        ] {
            let error = call(&natives, name, &args).unwrap_err();
            assert!(error.props.contains(&("code".into(), "ENOENT".into())));
            assert!(error.props.contains(&("errno".into(), (-2).into())));
            assert!(error.props.contains(&("syscall".into(), syscall.into())));
            assert!(error.props.contains(&("path".into(), "".into())));
        }
        assert_eq!(
            call(&natives, "exists", &["".into()]).unwrap(),
            false.into()
        );
        assert_eq!(
            call(&natives, "rm", &["".into(), true.into(), true.into()]).unwrap(),
            Val::Undefined
        );
        assert_eq!(
            open_file("", 0, 0).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }
    use crate::transpiler::PassthroughTranspiler;

    fn call(table: &Table, name: &str, args: &[Val]) -> NativeResult {
        let (_, function) = table
            .functions
            .iter()
            .find(|(key, _)| *key == name)
            .expect("shared data native");
        function(Args(args))
    }

    #[test]
    fn filesystem_integer_serialization_preserves_unsafe_numbers() {
        let value = 9_007_199_254_740_993;
        assert_eq!(metadata_integer(value, true), Val::BigUint(value));
        assert_eq!(metadata_integer(value, false), Val::Num(value as f64));
        assert_eq!(metadata_integer(u64::MAX, true), Val::BigUint(u64::MAX));
        assert_eq!(nanos(Ok(UNIX_EPOCH - Duration::new(1, 1))), -1_000_000_001);
    }

    #[test]
    fn filesystem_millisecond_times_keep_their_fraction() {
        let record = metadata_record(
            [("dev", 0); 8],
            [("blksize", 0); 2],
            [
                ("atime", 1_700_000_000_250_000_000),
                ("mtime", -1_500_000_000),
                ("ctime", 0),
                ("birthtime", 0),
            ],
            false,
        );
        let Val::Object(fields) = record else {
            panic!("expected a record")
        };
        let field = |name: &str| {
            fields
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        assert_eq!(field("atimeMs"), Some(Val::Num(1_700_000_000_250.0)));
        assert_eq!(field("mtimeMs"), Some(Val::Num(-1_500.0)));
    }

    #[test]
    fn filesystem_sync_flags_select_full_or_data_barriers() {
        assert!(matches!(sync_mode(1052672), SyncMode::All));
        assert!(matches!(sync_mode(1052674), SyncMode::All));
        assert!(matches!(sync_mode(4097), SyncMode::Data));
        assert!(matches!(sync_mode(577), SyncMode::None));
    }

    #[test]
    fn path_changing_natives_forget_remembered_require_targets() {
        use crate::resolve::{Kind, Resolved};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        let name = format!(
            "bun-wasm-required-{}-{}",
            std::process::id(),
            nanos.as_nanos()
        );
        let root = std::env::temp_dir().join(name);
        fs::create_dir_all(root.join("lib/a")).unwrap();
        fs::write(root.join("lib/a/index.js"), "module.exports = 1;\n").unwrap();
        let path = |relative: &str| root.join(relative).to_str().unwrap().to_owned();
        let state = test_state();
        let mut natives = Table::default();
        install_fs(&mut natives, &state);
        install_fds(&mut natives, &state);
        forget_required_after_path_changes(&mut natives, &state);
        let from = path("index.js");
        let found = || state.resolver.resolve("./lib/a", &from, Kind::Require);
        let index = Ok(Resolved::File(path("lib/a/index.js")));
        let file = Ok(Resolved::File(path("lib/a.js")));
        assert_eq!(found(), index);
        // A higher-precedence file written by this process wins at once.
        let source: Val = "module.exports = 2;\n".into();
        call(&natives, "writeFile", &[path("lib/a.js").into(), source]).unwrap();
        assert_eq!(found(), file);
        // Reading through `open` keeps the remembered target.
        fs::remove_file(root.join("lib/a.js")).unwrap();
        let fd = call(&natives, "open", &[path("lib/a/index.js").into(), 0.into()]).unwrap();
        call(&natives, "close", &[fd]).unwrap();
        assert_eq!(found(), file);
        // Removing it through the runtime falls back to the directory's index again.
        fs::write(root.join("lib/a.js"), "module.exports = 2;\n").unwrap();
        call(&natives, "unlink", &[path("lib/a.js").into()]).unwrap();
        assert_eq!(found(), index);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn archive_extract_and_sqlite_create_forget_remembered_require_targets() {
        use crate::resolve::{Kind, Resolved};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        let name = format!(
            "bun-wasm-required-late-{}-{}",
            std::process::id(),
            nanos.as_nanos()
        );
        let root = std::env::temp_dir().join(name);
        fs::create_dir_all(root.join("lib/a")).unwrap();
        fs::write(root.join("lib/a/index.js"), "module.exports = 1;\n").unwrap();
        let path = |relative: &str| root.join(relative).to_str().unwrap().to_owned();
        let state = test_state();
        // The whole table: natives installed after the file-system ones are covered too.
        let natives = table(&state);
        let from = path("index.js");
        let found = || state.resolver.resolve("./lib/a", &from, Kind::Require);
        let index = Ok(Resolved::File(path("lib/a/index.js")));
        let file = Ok(Resolved::File(path("lib/a.js")));
        assert_eq!(found(), index);
        // Bun.Archive.extract writing a higher-precedence file makes it the target.
        let mut header = tar::Header::new_ustar();
        header.set_path("lib/a.js").unwrap();
        header.set_size(1);
        header.set_mode(0o644);
        header.set_cksum();
        let mut tar = header.as_bytes().to_vec();
        tar.push(b'2');
        tar.resize(512 * 4, 0);
        let destination: Val = path("").into();
        call(&natives, "archive.extract", &[Val::Bytes(tar), destination]).unwrap();
        assert_eq!(found(), file);
        // An SQLite open that cannot create its file keeps the target; one that can forgets it.
        fs::remove_file(root.join("lib/a.js")).unwrap();
        let database: Val = path("data.db").into();
        let readonly = call(&natives, "sqlite.open", &[database.clone(), 1.into()]);
        assert!(readonly.is_err());
        assert_eq!(found(), file);
        let handle = call(&natives, "sqlite.open", &[database, 6.into()]).unwrap();
        assert_eq!(found(), index);
        call(&natives, "sqlite.close", &[handle, false.into()]).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn filesystem_open_and_copy_flags_preserve_existing_data() {
        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let fixture = Fixture(std::env::temp_dir().join(format!(
            "bun-wasm-fs-options-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        )));
        fs::create_dir(&fixture.0).unwrap();
        let existing = fixture.0.join("existing");
        let missing = fixture.0.join("missing");
        fs::write(&existing, b"original").unwrap();
        let existing = existing.to_str().unwrap();
        let missing = missing.to_str().unwrap();
        drop(open_file(existing, 1, 0o644).unwrap());
        assert_eq!(fs::read(existing).unwrap(), b"original");
        assert_eq!(
            open_file(missing, 1, 0o644).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            open_file(existing, 705, 0o644).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            copy_file(existing, existing, 1).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(existing).unwrap(), b"original");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(existing, fs::Permissions::from_mode(0o751)).unwrap();
            copy_file(existing, missing, 1).unwrap();
            assert_eq!(
                fs::metadata(missing).unwrap().permissions().mode() & 0o777,
                0o751
            );
            fs::remove_file(missing).unwrap();
        }
        // Read-only creation cannot be expressed by std::fs::OpenOptions.
        drop(open_file(missing, 64, 0o600).unwrap());
        assert!(fs::metadata(missing).unwrap().is_file());
        open_file(existing, 1025, 0o644)
            .unwrap()
            .write_all(b"!")
            .unwrap();
        assert_eq!(fs::read(existing).unwrap(), b"original!");
        let state = test_state();
        let Val::Object(fields) =
            stat_record(&state, &path_metadata(existing, false).unwrap(), true)
        else {
            panic!("stat record");
        };
        assert!(fields.contains(&("size".into(), Val::BigUint(9))));
        assert!(
            fields
                .iter()
                .any(|(name, value)| name == "mtimeNs" && matches!(value, Val::Str(_)))
        );
        assert_eq!(
            open_file(existing, 2048, 0o644).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        drop(open_file(existing, 513, 0o644).unwrap());
        assert!(fs::read(existing).unwrap().is_empty());
    }

    struct FilesystemFixture(std::path::PathBuf);

    impl FilesystemFixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "bun-wasm-fs-options-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_str().unwrap().to_owned()
        }
    }

    impl Drop for FilesystemFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn filesystem_write_bindings_retain_default_and_explicit_modes() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = FilesystemFixture::new();
        let reference = fixture.path("reference");
        fs::write(&reference, b"x").unwrap();
        let expected = fs::metadata(&reference).unwrap().permissions().mode() & 0o777;
        let mut natives = Table::default();
        install_fs(&mut natives, &test_state());
        let bun_file = fixture.path("bun-file");
        call(
            &natives,
            "writeFile",
            &[bun_file.clone().into(), "x".into(), false.into()],
        )
        .unwrap();
        let node_file = fixture.path("node-file");
        call(
            &natives,
            "writeFileFlags",
            &[node_file.clone().into(), "x".into(), 577.into()],
        )
        .unwrap();
        for path in [&bun_file, &node_file] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                expected
            );
        }
        let explicit = fixture.path("explicit");
        call(
            &natives,
            "writeFileFlags",
            &[
                explicit.clone().into(),
                "x".into(),
                577.into(),
                0o600.into(),
            ],
        )
        .unwrap();
        assert_eq!(
            fs::metadata(explicit).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn filesystem_stat_serializes_one_snapshot_after_path_replacement() {
        use std::os::unix::fs::MetadataExt;
        let fixture = FilesystemFixture::new();
        let path = fixture.path("path");
        let replacement = fixture.path("replacement");
        fs::write(&path, b"old").unwrap();
        fs::write(&replacement, b"replacement").unwrap();
        let original = fs::metadata(&path).unwrap();
        let snapshot = path_metadata(&path, false).unwrap();
        fs::rename(&replacement, &path).unwrap();
        let state = test_state();
        let Val::Object(fields) = stat_record(&state, &snapshot, true) else {
            panic!("stat record");
        };
        assert!(fields.contains(&("ino".into(), Val::BigUint(original.ino()))));
        assert!(fields.contains(&("size".into(), Val::BigUint(3))));
        let Val::Object(current) = stat_record(&state, &path_metadata(&path, false).unwrap(), true)
        else {
            panic!("stat record");
        };
        assert!(current.contains(&("size".into(), Val::BigUint(11))));
        assert!(!current.contains(&("ino".into(), Val::BigUint(original.ino()))));
    }

    #[test]
    fn real_descriptors_accept_inherited_files_without_stealing_their_lifetime() {
        use std::io::{Read, Seek, SeekFrom};
        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_file(&self.0);
            }
        }
        let path = std::env::temp_dir().join(format!(
            "bun-wasm-native-fds-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let fixture = Fixture(path);
        let mut inherited = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&fixture.0)
            .unwrap();
        inherited.write_all(b"xxcursor!").unwrap();
        inherited.seek(SeekFrom::Start(2)).unwrap();
        let fd = Val::Num(inherited.as_raw_fd() as f64);
        let state = Rc::new(State::new(Vec::new(), Box::new(PassthroughTranspiler)));
        let natives = table(&state);
        assert_eq!(
            call(
                &natives,
                "read",
                &[fd.clone(), Val::Num(2.0), Val::Num(0.0)]
            )
            .unwrap(),
            Val::Bytes(b"xx".to_vec())
        );
        assert_eq!(inherited.stream_position().unwrap(), 2);
        assert_eq!(
            call(
                &natives,
                "read",
                &[fd.clone(), Val::Num(6.0), Val::Num(-1.0)]
            )
            .unwrap(),
            Val::Bytes(b"cursor".to_vec())
        );
        assert_eq!(inherited.stream_position().unwrap(), 8);
        call(
            &natives,
            "write",
            &[fd.clone(), Val::Bytes(b"X".to_vec()), Val::Num(0.0)],
        )
        .unwrap();
        assert_eq!(inherited.stream_position().unwrap(), 8);
        assert!(call(&natives, "fstat", std::slice::from_ref(&fd)).is_ok());
        call(&natives, "ftruncate", &[fd.clone(), Val::Num(10.0)]).unwrap();
        assert_eq!(inherited.metadata().unwrap().len(), 10);
        call(
            &natives,
            "writev",
            &[
                fd.clone(),
                Val::Array(vec![Val::Bytes(b"?".to_vec())]),
                Val::Num(-1.0),
            ],
        )
        .unwrap();
        call(&natives, "seek", &[fd.clone(), Val::Num(8.0)]).unwrap();
        assert_eq!(inherited.stream_position().unwrap(), 8);
        assert_eq!(
            call(
                &natives,
                "read",
                &[fd.clone(), Val::Num(1.0), Val::Num(-1.0)]
            )
            .unwrap(),
            Val::Bytes(b"?".to_vec())
        );
        assert_eq!(inherited.stream_position().unwrap(), 9);
        let own = call(
            &natives,
            "open",
            &[Val::from(fixture.0.to_str().unwrap()), Val::Num(0.0)],
        )
        .unwrap();
        let Val::Num(own_fd) = own else {
            panic!("open must return descriptor")
        };
        assert_ne!(own_fd, inherited.as_raw_fd() as f64);
        assert_eq!(
            state.fds.borrow().files[&(own_fd as i32)].as_raw_fd() as f64,
            own_fd
        );
        call(&natives, "close", &[Val::Num(own_fd)]).unwrap();
        assert!(!state.fds.borrow().files.contains_key(&(own_fd as i32)));
        assert!(!state.fds.borrow().sync_modes.contains_key(&(own_fd as i32)));
        let error = call(
            &natives,
            "read",
            &[Val::Num(-1.0), Val::Num(1.0), Val::Num(-1.0)],
        )
        .unwrap_err();
        assert!(error.props.contains(&("code".into(), Val::from("EBADF"))));
        drop(natives);
        drop(state);
        inherited.seek(SeekFrom::Start(8)).unwrap();
        let mut suffix = [0];
        inherited.read_exact(&mut suffix).unwrap();
        assert_eq!(suffix, [b'?']);
    }

    #[test]
    fn writes_preserve_partial_progress_and_retry_interruptions() {
        let mut attempts = 0;
        assert_eq!(
            write_chunks_with(b"abcd", Some(10), |bytes, offset| {
                attempts += 1;
                if attempts == 1 {
                    return Err(io::ErrorKind::Interrupted.into());
                }
                if attempts == 2 {
                    assert_eq!(bytes, b"abcd");
                    assert_eq!(offset, Some(10));
                    return Ok(2);
                }
                assert_eq!(bytes, b"cd");
                assert_eq!(offset, Some(12));
                Err(io::ErrorKind::WouldBlock.into())
            })
            .unwrap(),
            2
        );
        assert_eq!(attempts, 3);
        assert_eq!(
            write_chunks_with(b"a", None, |_, _| Err(
                io::ErrorKind::PermissionDenied.into()
            ))
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            write_chunks_with(b"ab", Some(libc::off_t::MAX), |_, _| Ok(1)).unwrap(),
            1
        );
        assert_eq!(
            write_chunks_with(b"a", None, |_, _| Ok(0))
                .unwrap_err()
                .kind(),
            io::ErrorKind::WriteZero
        );
        assert_eq!(
            write_chunks_with(b"", None, |bytes, _| {
                assert!(bytes.is_empty());
                Err(io::Error::from_raw_os_error(libc::EBADF))
            })
            .unwrap_err()
            .raw_os_error(),
            Some(libc::EBADF)
        );
        let mut interrupted = true;
        assert_eq!(
            retry_interrupted(|| {
                if interrupted {
                    interrupted = false;
                    Err(io::ErrorKind::Interrupted.into())
                } else {
                    Ok(7)
                }
            })
            .unwrap(),
            7
        );
    }

    #[test]
    fn invalid_descriptors_reject_close_and_empty_io() {
        let state = Rc::new(State::new(Vec::new(), Box::new(PassthroughTranspiler)));
        let natives = table(&state);
        for fd in [-1, -7, i32::MIN, i32::MAX] {
            for (name, args) in [
                ("close", vec![Val::Num(f64::from(fd))]),
                ("read", vec![Val::Num(f64::from(fd)), Val::Num(0.0)]),
                ("fstat", vec![Val::Num(f64::from(fd))]),
                ("ftruncate", vec![Val::Num(f64::from(fd)), Val::Num(0.0)]),
                ("write", vec![Val::Num(f64::from(fd)), Val::Bytes(vec![])]),
                ("writev", vec![Val::Num(f64::from(fd)), Val::Array(vec![])]),
            ] {
                let error = call(&natives, name, &args).unwrap_err();
                assert!(
                    error.props.contains(&("code".into(), Val::from("EBADF"))),
                    "{name}({fd}): {error:?}"
                );
            }
        }
    }

    #[test]
    fn empty_writes_reject_closed_descriptors() {
        let state = Rc::new(State::new(Vec::new(), Box::new(PassthroughTranspiler)));
        let natives = table(&state);
        // Negative descriptors cannot be concurrently allocated by another test.
        let error = call(&natives, "write", &[Val::Num(-1.0), Val::Bytes(vec![])]).unwrap_err();
        assert!(error.props.contains(&("code".into(), Val::from("EBADF"))));
        // A descriptor outside the process limit is likewise guaranteed closed.
        for vectors in [
            vec![],
            vec![Val::Bytes(vec![])],
            vec![Val::Bytes(vec![]), Val::Bytes(vec![])],
        ] {
            let error = call(
                &natives,
                "writev",
                &[Val::Num(i32::MAX as f64), Val::Array(vectors)],
            )
            .unwrap_err();
            assert!(error.props.contains(&("code".into(), Val::from("EBADF"))));
        }
    }

    #[cfg(unix)]
    #[test]
    fn inherited_pipe_and_character_device_keep_their_type() {
        use std::os::unix::net::UnixStream;
        let (socket, _peer) = UnixStream::pair().unwrap();
        let mut pipes = [-1; 2];
        assert_eq!(unsafe { libc::pipe(pipes.as_mut_ptr()) }, 0);
        let reader = unsafe { File::from_raw_fd(pipes[0]) };
        let _writer = unsafe { File::from_raw_fd(pipes[1]) };
        let device = File::open("/dev/null").unwrap();
        let state = Rc::new(State::new(Vec::new(), Box::new(PassthroughTranspiler)));
        let natives = table(&state);
        for (fd, kind) in [
            (reader.as_raw_fd(), 0o010000),
            (device.as_raw_fd(), 0o020000),
            (socket.as_raw_fd(), 0o140000),
        ] {
            let Val::Object(fields) = call(&natives, "fstat", &[Val::Num(fd as f64)]).unwrap()
            else {
                panic!("stat object");
            };
            let (_, Val::Num(mode)) = fields.iter().find(|(key, _)| key == "mode").unwrap() else {
                panic!("mode");
            };
            assert_eq!(*mode as u32 & 0o170000, kind);
        }
    }

    #[test]
    fn generated_builtins_use_shared_data_natives() {
        bunwasm_glue::init();
        #[cfg(target_os = "wasi")]
        bunwasm_posix::init();
        let state = Rc::new(State::new(Vec::new(), Box::new(PassthroughTranspiler)));
        let table = table(&state);
        let Val::Array(names) = call(&table, "bunBuiltinNames", &[]).unwrap() else {
            panic!("module names must be data")
        };
        let id = names
            .iter()
            .position(|name| *name == Val::from("internal:freelist"))
            .unwrap();
        let Val::Str(source) = call(&table, "bunBuiltinSource", &[Val::Num(id as f64)]).unwrap()
        else {
            panic!("factory must be source text")
        };
        assert!(source.contains("class FreeList"));
        assert_eq!(
            call(&table, "bunBuiltinSource", &[Val::Num(u32::MAX as f64)]).unwrap(),
            Val::Undefined
        );
        assert!(matches!(
            call(&table, "bunBuiltinHookName", &[Val::Num(0.0)]).unwrap(),
            Val::Str(_)
        ));
        let error_id = modules::BUN_BUILTIN_ERROR_CODES
            .iter()
            .position(|code| *code == "ERR_INVALID_URI")
            .unwrap();
        assert_eq!(
            call(&table, "bunBuiltinErrorCode", &[Val::Num(error_id as f64)]).unwrap(),
            Val::from("ERR_INVALID_URI")
        );
        for invalid in [
            Val::Num(-1.0),
            Val::Num(0.5),
            Val::Num(f64::INFINITY),
            Val::Bool(true),
            Val::from("22"),
        ] {
            assert_eq!(
                call(&table, "bunBuiltinSource", &[invalid])
                    .unwrap_err()
                    .kind,
                crate::data::ErrorKind::TypeError
            );
        }
    }
}

#[cfg(test)]
mod write_once_tests {
    use super::*;

    fn natives() -> Table {
        let mut table = Table::default();
        write_once_natives(&mut table, |fd, bytes| fd * 100 + bytes.len() as i32);
        table
    }

    fn write(table: &Table, fd: i32, bytes: &[u8], token: u64) -> Val {
        let args = [
            fd.into(),
            Val::Bytes(bytes.to_vec()),
            Val::Num(token as f64),
        ];
        (table.functions[0].1)(Args(&args)).unwrap()
    }

    fn result(table: &Table, fd: u32, token: u64) -> i64 {
        let mut words = [0; crate::data::WORD_ARGS];
        words[..3].copy_from_slice(&[fd, (token >> 32) as u32, token as u32]);
        (table.words[0].1)(&words)
    }

    #[test]
    fn a_write_result_answers_only_the_attempt_that_made_it() {
        let table = natives();
        assert_eq!(result(&table, 4, 1), UNWRITTEN, "nothing has run yet");
        // Channel A writes on descriptor 4 and gets its reply.
        assert_eq!(write(&table, 4, b"moving", 1), Val::from(406));
        assert_eq!(result(&table, 4, 1), 406);
        // Channel B's first write never reached the core. Neither A's token on B's descriptor
        // nor a token of B's own may read A's count.
        assert_eq!(result(&table, 6, 1), UNWRITTEN, "another channel's attempt");
        assert_eq!(result(&table, 6, 2), UNWRITTEN);
        assert_eq!(
            result(&table, 4, 2),
            UNWRITTEN,
            "a later attempt that never ran"
        );
        // B's write runs, and its lost reply is read back by B alone.
        assert_eq!(write(&table, 6, b"wake", 2), Val::from(604));
        assert_eq!(result(&table, 6, 2), 604);
        assert_eq!(
            result(&table, 4, 1),
            UNWRITTEN,
            "only the last attempt is kept"
        );
        // A token is 53 bits wide and both of its words count.
        let wide = (1 << 40) | 2;
        assert_eq!(write(&table, 6, b"x", wide), Val::from(601));
        assert_eq!(result(&table, 6, wide), 601);
        assert_eq!(result(&table, 6, 2), UNWRITTEN);
        assert_eq!(result(&table, 6, 0), UNWRITTEN, "zero names no attempt");
    }
}

#[cfg(test)]
mod descriptor_kind_tests {
    use super::descriptor_mode;

    #[test]
    fn unknown_is_not_a_pipe_and_kind_does_not_bypass_errors() {
        assert_eq!(descriptor_mode(0, 0).unwrap(), 0);
        assert_eq!(descriptor_mode(0o600, 1).unwrap(), 0o010600);
        assert_eq!(descriptor_mode(0o020600, 2).unwrap(), 0o020600);
        assert_eq!(descriptor_mode(0o100600, 3).unwrap(), 0o100600);
        assert_eq!(descriptor_mode(0o040700, 4).unwrap(), 0o040700);
        assert_eq!(descriptor_mode(0, -8).unwrap_err().raw_os_error(), Some(8));
    }
}

#[cfg(test)]
mod bun_string_round_trip_tests {
    use super::bun_string_round_trip;
    use crate::data::Val;

    fn decoded(bytes: &[u8], encoding: &str) -> Vec<u8> {
        let Val::Object(fields) = bun_string_round_trip(bytes, encoding).unwrap() else {
            panic!("round trip returns an object");
        };
        assert!(
            matches!(fields[0], (ref name, Val::Num(address)) if name == "address" && address > 0.0)
        );
        let (name, Val::Bytes(bytes)) = &fields[1] else {
            panic!("round trip returns bytes");
        };
        assert_eq!(name, "bytes");
        bytes.clone()
    }

    #[test]
    fn every_encoding_decodes_its_own_bytes() {
        let latin1 = [b'c', b'a', b'f', 0xe9];
        assert_eq!(decoded(&latin1, "latin1"), latin1);
        let utf8 = "東京 ✓".as_bytes();
        assert_eq!(decoded(utf8, "utf8"), utf8);
        let utf16: Vec<u8> = "🦊é".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decoded(&utf16, "utf16le"), utf16);
        assert!(bun_string_round_trip(b"x", "ucs2").is_err());
    }
}
