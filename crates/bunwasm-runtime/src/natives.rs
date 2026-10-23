//! Native functions exposed to the JS side of the runtime as the `native`
//! object. The JS polyfills (src/js/*.js) build the public Bun/Node/Web APIs on
//! top of these; nothing here is reachable from user code directly.
//!
//! These natives are engine-agnostic: they take and return plain data
//! ([`Val`]). Byte buffers cross as `Uint8Array` (JS converts other views
//! first), paths are absolute strings, and failures throw Node-style errors
//! (`code`, `errno`, `syscall`, `path`). The natives that need engine values
//! (module loading, promise and proxy introspection) are in
//! engine_natives.rs.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::mem::{ManuallyDrop, MaybeUninit};
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
#[cfg(target_os = "wasi")]
use std::os::wasi::fs::FileTypeExt;
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::State;
use crate::engine::{Args, DataFn, NativeError, NativeResult, Record, Val};
use crate::modules;
use crate::resolve::{self, Kind, Resolved};

/// Natives by name, plus constant properties of the `native` object.
#[derive(Default)]
pub struct Table {
    pub functions: Vec<(&'static str, DataFn)>,
    pub constants: Vec<(&'static str, Val)>,
}

impl Table {
    pub(crate) fn add(
        &mut self,
        name: &'static str,
        f: impl Fn(Args<'_>) -> NativeResult + 'static,
    ) {
        self.functions.push((name, Rc::new(f)));
    }
}

/// Node's (code, negative Linux errno, description) for an I/O error.
fn flat_edits(edits: Vec<(usize, &'static str)>) -> Val {
    let flat = edits
        .into_iter()
        .flat_map(|(at, text)| [Val::Num(at as f64), Val::Str(text.to_owned())]);
    Val::Array(flat.collect())
}

fn errno_info(err: &io::Error) -> (&'static str, i32, &'static str) {
    use io::ErrorKind as K;
    if err.raw_os_error() == Some(libc::EBADF) {
        return ("EBADF", -9, "bad file descriptor");
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

fn stat_record(meta: &fs::Metadata, descriptor_mode: Option<libc::mode_t>) -> Val {
    let ft = meta.file_type();
    let (kind_bits, perm) = if ft.is_dir() {
        (0o040000, 0o755)
    } else if ft.is_symlink() {
        (0o120000, 0o777)
    } else {
        (special_file_bits(ft), 0o644)
    };
    let (dev, ino, nlink) = inode_info(meta);
    let mtime = millis(meta.modified());
    Record::new()
        .set("dev", dev)
        .set("ino", ino)
        .set(
            "mode",
            descriptor_mode
                .map(f64::from)
                .unwrap_or(f64::from(kind_bits | perm)),
        )
        .set("nlink", nlink)
        .set("uid", 0)
        .set("gid", 0)
        .set("rdev", 0)
        .set("size", meta.len() as f64)
        .set("blksize", 4096)
        .set("blocks", meta.len().div_ceil(512) as f64)
        .set("atimeMs", millis(meta.accessed()))
        .set("mtimeMs", mtime)
        .set("ctimeMs", mtime)
        .set("birthtimeMs", millis(meta.created()))
        .into()
}

#[cfg(any(unix, target_os = "wasi"))]
fn special_file_bits(kind: fs::FileType) -> u32 {
    #[cfg(unix)]
    if kind.is_fifo() {
        return 0o010000;
    }
    if kind.is_char_device() {
        return 0o020000;
    }
    if kind.is_block_device() {
        return 0o060000;
    }
    if kind.is_socket() {
        return 0o140000;
    }
    if kind.is_file() {
        return 0o100000;
    }
    0
}

#[cfg(not(any(unix, target_os = "wasi")))]
fn special_file_bits(kind: fs::FileType) -> u32 {
    if kind.is_file() { 0o100000 } else { 0 }
}

#[cfg(target_os = "wasi")]
fn inode_info(meta: &fs::Metadata) -> (f64, f64, f64) {
    use std::os::wasi::fs::MetadataExt;
    (meta.dev() as f64, meta.ino() as f64, meta.nlink() as f64)
}

#[cfg(unix)]
fn inode_info(meta: &fs::Metadata) -> (f64, f64, f64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev() as f64, meta.ino() as f64, meta.nlink() as f64)
}

#[cfg(not(any(unix, target_os = "wasi")))]
fn inode_info(_: &fs::Metadata) -> (f64, f64, f64) {
    (0.0, 0.0, 1.0)
}

fn copy_dir_all(from: &str, to: &str) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let (src, dst) = (format!("{from}/{name}"), format!("{to}/{name}"));
        if entry.file_type()?.is_dir() {
            copy_dir_all(&src, &dst)?;
        } else {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Own files opened by this runtime, indexed by their real process descriptor.
/// Inherited descriptors share that namespace and remain owned by the process host.
#[derive(Default)]
pub struct FdTable {
    files: HashMap<i32, File>,
}

fn descriptor_metadata(fd: i32) -> io::Result<(fs::Metadata, libc::mode_t)> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // Validate the descriptor before borrowing it. Guest native calls are synchronous;
    // no JS can close or reuse it between this check and metadata().
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // This view never acquires lifetime ownership: ManuallyDrop prevents close on
    // return (including errors). Owned opens remain in FdTable; inherited fds remain
    // owned by their host until an explicit close or process exit.
    let file = ManuallyDrop::new(unsafe { File::from_raw_fd(fd as _) });
    let mode = unsafe { stat.assume_init() }.st_mode;
    // Preview1 UNKNOWN is not a pipe tag. Preserve fstat's capability check and
    // consult the process resource only to restore FIFO's missing POSIX bits.
    #[cfg(target_os = "wasi")]
    let mode = descriptor_mode(mode, crate::host::proc_fd_kind(fd))?;
    Ok((file.metadata()?, mode))
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

fn descriptor_stat(fd: i32) -> io::Result<Val> {
    let (meta, mode) = descriptor_metadata(fd)?;
    Ok(stat_record(&meta, Some(mode)))
}

fn open_options(flags: &str) -> OpenOptions {
    let mut opts = OpenOptions::new();
    let plus = flags.contains('+');
    match flags.chars().next().unwrap_or('r') {
        'w' => opts.write(true).create(true).truncate(true).read(plus),
        'a' => opts.append(true).create(true).read(plus),
        _ => opts.read(true).write(plus),
    };
    if flags.contains('x') {
        opts.create_new(true);
    }
    opts
}

/// Every data native.
pub fn table(state: &Rc<State>) -> Table {
    let mut t = Table::default();
    crate::html_rewriter::install(&mut t);
    crate::x509::install(&mut t);
    install_process(&mut t, state);
    install_fs(&mut t);
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
    crate::node_path::install(&mut t);
    install_encoding(&mut t);
    crate::streams::install(&mut t);
    crate::archive::install(&mut t);
    install_crypto(&mut t);
    install_url(&mut t);
    install_host(&mut t, state);
    crate::sqlite::install(&mut t);
    crate::wasm::install(&mut t);
    t.constants.push(("platformInfo", platform_info()));
    t
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

fn install_fs(t: &mut Table) {
    t.add("readFile", |a| {
        let path = a.str(0)?;
        Ok(Val::Bytes(
            fs::read(path).map_err(|e| io_error(e, "open", Some(path)))?,
        ))
    });
    t.add("readFileUtf8", |a| {
        let path = a.str(0)?;
        let bytes = fs::read(path).map_err(|e| io_error(e, "open", Some(path)))?;
        Ok(String::from_utf8(bytes)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
            .into())
    });
    t.add("writeFile", |a| {
        let path = a.str(0)?;
        let bytes = a.bytes(1)?;
        let opts = open_options(if a.bool(2) { "a" } else { "w" });
        let mut file = opts
            .open(path)
            .map_err(|e| io_error(e, "open", Some(path)))?;
        file.write_all(bytes)
            .map_err(|e| io_error(e, "write", Some(path)))?;
        Ok(Val::Num(bytes.len() as f64))
    });
    t.add("exists", |a| {
        Ok(fs::symlink_metadata(a.str(0)?).is_ok().into())
    });
    t.add("stat", |a| {
        let path = a.str(0)?;
        let lstat = a.bool(1);
        let meta = if lstat {
            fs::symlink_metadata(path)
        } else {
            fs::metadata(path)
        };
        let meta =
            meta.map_err(|e| io_error(e, if lstat { "lstat" } else { "stat" }, Some(path)))?;
        Ok(stat_record(&meta, None))
    });
    t.add("mkdir", |a| {
        let path = a.str(0)?;
        if !a.bool(1) {
            fs::create_dir(path).map_err(|e| io_error(e, "mkdir", Some(path)))?;
            return Ok(Val::Null);
        }
        // Node returns the first directory actually created.
        let mut first = None;
        let mut current = String::new();
        for part in path.split('/').filter(|p| !p.is_empty()) {
            current = format!("{current}/{part}");
            if fs::metadata(&current).is_ok() {
                continue;
            }
            fs::create_dir(&current).map_err(|e| io_error(e, "mkdir", Some(path)))?;
            first.get_or_insert_with(|| current.clone());
        }
        Ok(first.map_or(Val::Null, Val::Str))
    });
    t.add("readdir", |a| {
        let path = a.str(0)?;
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
    t.add("rm", |a| {
        let path = a.str(0)?;
        let meta = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(_) if a.bool(2) => return ok(),
            Err(e) => return Err(io_error(e, "rm", Some(path))),
        };
        let result = match (meta.is_dir(), a.bool(1)) {
            (true, true) => fs::remove_dir_all(path),
            (true, false) => Err(io::Error::from(io::ErrorKind::IsADirectory)),
            _ => fs::remove_file(path),
        };
        result.map_err(|e| io_error(e, "rm", Some(path)))?;
        ok()
    });
    t.add("rmdir", |a| {
        let path = a.str(0)?;
        let result = if a.bool(1) {
            fs::remove_dir_all(path)
        } else {
            fs::remove_dir(path)
        };
        result.map_err(|e| io_error(e, "rmdir", Some(path)))?;
        ok()
    });
    t.add("unlink", |a| {
        let path = a.str(0)?;
        fs::remove_file(path).map_err(|e| io_error(e, "unlink", Some(path)))?;
        ok()
    });
    t.add("rename", |a| {
        let (from, to) = (a.str(0)?, a.str(1)?);
        fs::rename(from, to).map_err(|e| io_error(e, "rename", Some(from)))?;
        ok()
    });
    t.add("copyFile", |a| {
        let (from, to) = (a.str(0)?, a.str(1)?);
        fs::copy(from, to).map_err(|e| io_error(e, "copyfile", Some(from)))?;
        ok()
    });
    t.add("copyDir", |a| {
        let (from, to) = (a.str(0)?, a.str(1)?);
        copy_dir_all(from, to).map_err(|e| io_error(e, "cp", Some(from)))?;
        ok()
    });
    t.add("realpath", |a| {
        let path = a.str(0)?;
        let real = fs::canonicalize(path)
            .map(|p| p.to_string_lossy().into_owned())
            .or_else(|e| match fs::metadata(path) {
                // WASI has no realpath; a lexically normalized path is the best we can do.
                Ok(_) => Ok(resolve::normalize(path)),
                Err(_) => Err(e),
            })
            .map_err(|e| io_error(e, "realpath", Some(path)))?;
        Ok(real.into())
    });
    t.add("readlink", |a| {
        let path = a.str(0)?;
        let target = fs::read_link(path).map_err(|e| io_error(e, "readlink", Some(path)))?;
        Ok(target.to_string_lossy().into_owned().into())
    });
    t.add("symlink", |a| {
        let (target, path) = (a.str(0)?, a.str(1)?);
        symlink(target, path).map_err(|e| io_error(e, "symlink", Some(path)))?;
        ok()
    });
    t.add("link", |a| {
        let (from, to) = (a.str(0)?, a.str(1)?);
        fs::hard_link(from, to).map_err(|e| io_error(e, "link", Some(from)))?;
        ok()
    });
    t.add("truncate", |a| {
        let path = a.str(0)?;
        let file = OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|e| io_error(e, "open", Some(path)))?;
        file.set_len(a.opt_num(1).unwrap_or(0.0) as u64)
            .map_err(|e| io_error(e, "ftruncate", Some(path)))?;
        ok()
    });
}

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
    Ok(Val::Num(written as f64))
}

fn flush_descriptor_output(state: &State) -> io::Result<()> {
    state.flush_stdout()?;
    io::stderr().flush()
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
    if fd == 1 {
        state
            .write_stdout(bytes)
            .map_err(|e| io_error(e, "write", None))?;
        return Ok(Val::Num(bytes.len() as f64));
    }
    if fd == 2 {
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
    write_chunks_with(bytes, position, |bytes, offset| {
        write_chunk(fd, bytes, offset)
    })
    .map(|n| Val::Num(n as f64))
    .map_err(|e| io_error(e, "write", None))
}

fn close_descriptor(state: &State, args: Args<'_>) -> NativeResult {
    let fd = args.i32(0)?;
    if (0..=2).contains(&fd) {
        return ok();
    }
    if state.fds.borrow_mut().files.remove(&fd).is_some() {
        return ok();
    }
    if unsafe { libc::close(fd) } < 0 {
        return Err(io_error(io::Error::last_os_error(), "close", None));
    }
    ok()
}

fn read_descriptor(args: Args<'_>) -> NativeResult {
    let fd = args.i32(0)?;
    let mut buf = vec![0u8; args.num(1)? as usize];
    let position = args.opt_num(2).filter(|p| *p >= 0.0);
    // Positional reads must not advance the shared open-file cursor.
    let count = match position {
        Some(position) => unsafe {
            libc::pread(
                fd,
                buf.as_mut_ptr().cast(),
                buf.len(),
                position as libc::off_t,
            )
        },
        None => unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) },
    };
    if count < 0 {
        return Err(io_error(io::Error::last_os_error(), "read", None));
    }
    buf.truncate(count as usize);
    Ok(Val::Bytes(buf))
}

fn install_fds(t: &mut Table, state: &Rc<State>) {
    let st = state.clone();
    t.add("open", move |a| {
        let path = a.str(0)?;
        let flags = a.opt_str(1).unwrap_or("r");
        let file = open_options(flags)
            .open(path)
            .map_err(|e| io_error(e, "open", Some(path)))?;
        let fd = file.as_raw_fd();
        st.fds.borrow_mut().files.insert(fd, file);
        Ok(fd.into())
    });
    let st = state.clone();
    t.add("close", move |a| close_descriptor(&st, a));
    t.add("read", read_descriptor);
    let st = state.clone();
    t.add("write", move |a| write_descriptor(&st, a));
    let st = state.clone();
    t.add("writev", move |a| writev(&st, a));
    t.add("fstat", |a| {
        descriptor_stat(a.i32(0)?).map_err(|e| io_error(e, "fstat", None))
    });
    t.add("ftruncate", |a| {
        let result =
            unsafe { libc::ftruncate(a.i32(0)?, a.opt_num(1).unwrap_or(0.0) as libc::off_t) };
        if result < 0 {
            return Err(io_error(io::Error::last_os_error(), "ftruncate", None));
        }
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
    t.add("functionImports", move |a| {
        let strings = a.sources(0)?;
        let offsets = st
            .transpiler
            .function_imports(&strings, a.str(1)?)
            .map_err(NativeError::syntax_error)?;
        Ok(Val::Array(
            offsets
                .into_iter()
                .map(|items| Val::Array(items.into_iter().map(|i| (i as u32).into()).collect()))
                .collect(),
        ))
    });
    let st = state.clone();
    // Per source, `[offset, text, …]` in UTF-16 units: the host splices them
    // into its own string (engine-host.js `awaitHooked`).
    t.add("awaitHookEdits", move |a| {
        let sources = a.sources(0)?;
        let Some(edits) = st.transpiler.await_hook_edits(&sources, a.str(1)?) else {
            return Ok(Val::Null);
        };
        Ok(Val::Array(edits.into_iter().map(flat_edits).collect()))
    });
    let st = state.clone();
    t.add("registerObjectModule", move |a| {
        Ok(st.resolver.register_object_module(a.str(0)?).into())
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
    t.add("workerSource", move |a| {
        let path = a.str(1)?;
        st.transpiler
            .transpile(a.str(0)?, path, crate::transpiler::Loader::from_path(path))
            .map(Val::from)
            .map_err(NativeError::syntax_error)
    });
    let st = state.clone();
    t.add("moduleFormat", move |a| {
        Ok(st.load_source(a.str(0)?)?.1.name().into())
    });
    let st = state.clone();
    t.add("mapPosition", move |a| {
        let mapped = st.map_position(a.str(0)?, a.u32(1)?, a.u32(2)?);
        Ok(mapped.map_or(Val::Undefined, |(l, c)| {
            Val::Array(vec![l.into(), c.into()])
        }))
    });
    let st = state.clone();
    t.add("getSourceLine", move |a| {
        Ok(st.source_line(a.str(0)?, a.num(1)? as usize).into())
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
    t.add("utf8Encode", |a| {
        Ok(Val::Bytes(a.str(0)?.as_bytes().to_vec()))
    });
    t.add("utf8Decode", |a| {
        let bytes = a.bytes(0)?;
        match std::str::from_utf8(bytes) {
            Ok(s) => Ok(s.into()),
            Err(_) if a.bool(1) => Err(NativeError::type_error(
                "The encoded data was not valid for encoding utf-8",
            )),
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
    t.add("wyhash", |a| {
        let seed = a.opt_num(1).unwrap_or(0.0) as u64;
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
    t.add("procJobOf", |a| Ok(host::proc_job_of(a.i32(0)?).into()));
    t.add("procPipe", |_| {
        Ok(match host::proc_pipe() {
            Ok((read, write)) => Val::Array(vec![Val::Num(read as f64), Val::Num(write as f64)]),
            Err(code) => code.into(),
        })
    });
    t.add("procClose", |a| Ok(host::proc_close(a.i32(0)?).into()));
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
    t.add("hostFetchHead", |a| {
        text_or_code(host::fetch_head(a.i32(0)?))
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
        let own = call(
            &natives,
            "open",
            &[Val::from(fixture.0.to_str().unwrap()), Val::from("r")],
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
        let error = call(
            &natives,
            "read",
            &[Val::Num(own_fd), Val::Num(1.0), Val::Num(-1.0)],
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
                crate::engine::ErrorKind::TypeError
            );
        }
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
