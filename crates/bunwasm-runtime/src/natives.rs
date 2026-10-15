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
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::engine::{Args, DataFn, NativeError, NativeResult, Record, Val};
use crate::resolve::{self, Kind, Resolved};
use crate::State;

/// Natives by name, plus constant properties of the `native` object.
#[derive(Default)]
pub struct Table {
    pub functions: Vec<(&'static str, DataFn)>,
    pub constants: Vec<(&'static str, Val)>,
}

impl Table {
    pub(crate) fn add(&mut self, name: &'static str, f: impl Fn(Args<'_>) -> NativeResult + 'static) {
        self.functions.push((name, Rc::new(f)));
    }
}

/// Node's (code, negative Linux errno, description) for an I/O error.
fn errno_info(err: &io::Error) -> (&'static str, i32, &'static str) {
    use io::ErrorKind as K;
    match err.kind() {
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
    e.prop("syscall", syscall).prop("errno", errno).prop("code", code)
}

fn bad_fd(syscall: &str) -> NativeError {
    NativeError::error(format!("EBADF: bad file descriptor, {syscall}"))
        .prop("syscall", syscall)
        .prop("errno", -9)
        .prop("code", "EBADF")
}

fn millis(time: io::Result<SystemTime>) -> f64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn stat_record(meta: &fs::Metadata) -> Val {
    let ft = meta.file_type();
    let (kind_bits, perm) = if ft.is_dir() {
        (0o040000, 0o755)
    } else if ft.is_symlink() {
        (0o120000, 0o777)
    } else {
        (0o100000, 0o644)
    };
    let (dev, ino, nlink) = inode_info(meta);
    let mtime = millis(meta.modified());
    Record::new()
        .set("dev", dev)
        .set("ino", ino)
        .set("mode", (kind_bits | perm) as f64)
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

/// Open files by fake fd (WASI has real fds, but std does not expose a way to
/// adopt arbitrary numbers, so we keep our own table starting at 3).
#[derive(Default)]
pub struct FdTable {
    files: HashMap<i32, File>,
    next: i32,
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
    install_process(&mut t, state);
    install_fs(&mut t);
    install_fds(&mut t, state);
    install_modules(&mut t, state);
    let st = state.clone();
    t.add("parseData", move |a| {
        st.transpiler.parse_data(a.bytes(0)?, a.str(1)?)
            .map(Val::Str)
    });
    crate::glob::install(&mut t);
    crate::semver::install(&mut t);
    install_encoding(&mut t);
    install_crypto(&mut t);
    install_url(&mut t);
    install_host(&mut t);
    crate::sqlite::install(&mut t);
    t.constants.push(("platformInfo", platform_info()));
    t
}

fn ok() -> NativeResult {
    Ok(Val::Undefined)
}

fn install_process(t: &mut Table, state: &Rc<State>) {
    let st = state.clone();
    t.add("writeStdout", move |a| {
        st.write_stdout(a.bytes(0)?);
        ok()
    });
    let st = state.clone();
    t.add("writeStderr", move |a| {
        st.write_stderr(a.bytes(0)?);
        ok()
    });
    let st = state.clone();
    t.add("exit", move |a| st.exit(a.opt_num(0).unwrap_or(0.0) as i32));
    let st = state.clone();
    t.add("argv", move |_| Ok(Val::Array(st.argv.iter().map(|s| Val::from(s.as_str())).collect())));
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
            .map(|(k, v)| (k.to_string_lossy().into_owned(), Val::Str(v.to_string_lossy().into_owned())))
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
    t.add("now", move |_| Ok(Val::Num(st.start.elapsed().as_secs_f64() * 1000.0)));
    let st = state.clone();
    t.add("nanoseconds", move |_| Ok(Val::Num(st.start.elapsed().as_nanos() as f64)));
    t.add("timeOrigin", |_| Ok(Val::Num(millis(Ok(SystemTime::now())))));
    let st = state.clone();
    t.add("sleep", move |a| {
        st.flush();
        let ms = a.opt_num(0).unwrap_or(0.0);
        if ms > 0.0 {
            crate::host::sleep(Duration::from_secs_f64(ms / 1000.0));
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
    t.add("readStdin", |_| {
        let mut buf = Vec::new();
        io::stdin().read_to_end(&mut buf).map_err(|e| io_error(e, "read", None))?;
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
        Ok(Val::Bytes(fs::read(path).map_err(|e| io_error(e, "open", Some(path)))?))
    });
    t.add("readFileUtf8", |a| {
        let path = a.str(0)?;
        let bytes = fs::read(path).map_err(|e| io_error(e, "open", Some(path)))?;
        Ok(String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()).into())
    });
    t.add("writeFile", |a| {
        let path = a.str(0)?;
        let bytes = a.bytes(1)?;
        let opts = open_options(if a.bool(2) { "a" } else { "w" });
        let mut file = opts.open(path).map_err(|e| io_error(e, "open", Some(path)))?;
        file.write_all(bytes).map_err(|e| io_error(e, "write", Some(path)))?;
        Ok(Val::Num(bytes.len() as f64))
    });
    t.add("exists", |a| Ok(fs::symlink_metadata(a.str(0)?).is_ok().into()));
    t.add("stat", |a| {
        let path = a.str(0)?;
        let lstat = a.bool(1);
        let meta = if lstat { fs::symlink_metadata(path) } else { fs::metadata(path) };
        let meta = meta.map_err(|e| io_error(e, if lstat { "lstat" } else { "stat" }, Some(path)))?;
        Ok(stat_record(&meta))
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
        let result = if a.bool(1) { fs::remove_dir_all(path) } else { fs::remove_dir(path) };
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
        let file = OpenOptions::new().write(true).open(path).map_err(|e| io_error(e, "open", Some(path)))?;
        file.set_len(a.opt_num(1).unwrap_or(0.0) as u64).map_err(|e| io_error(e, "ftruncate", Some(path)))?;
        ok()
    });
}

#[cfg(target_os = "wasi")]
fn symlink(target: &str, path: &str) -> io::Result<()> {
    std::os::wasi::fs::symlink_path(target, path)
}

#[cfg(unix)]
fn symlink(target: &str, path: &str) -> io::Result<()> {
    std::os::unix::fs::symlink(target, path)
}

#[cfg(not(any(unix, target_os = "wasi")))]
fn symlink(_: &str, _: &str) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

fn write_file_at(file: &mut File, bytes: &[u8], position: Option<u64>) -> io::Result<()> {
    let Some(position) = position else { return file.write_all(bytes) };
    let cursor = file.stream_position()?;
    file.seek(SeekFrom::Start(position))?;
    let result = file.write_all(bytes);
    let restored = file.seek(SeekFrom::Start(cursor)).map(|_| ());
    result.and(restored)
}

fn writev(state: &State, args: Args<'_>) -> NativeResult {
    let fd = match args.get(0) {
        Val::Num(n) if n.fract() == 0.0 && *n >= 0.0 && *n <= f64::from(i32::MAX) => *n as i32,
        Val::Num(_) => return Err(NativeError::range_error("fd must be an integer between 0 and 2147483647").prop("code", "ERR_OUT_OF_RANGE")),
        _ => return Err(NativeError::type_error("fd must be a number").prop("code", "ERR_INVALID_ARG_TYPE")),
    };
    let buffers = args.array(1).ok_or_else(|| NativeError::type_error("expected an array of byte buffers"))?;
    let limit = unsafe { libc::sysconf(libc::_SC_IOV_MAX) };
    let limit = usize::try_from(limit).ok().filter(|&n| n > 0).unwrap_or(16).min(i32::MAX as usize);
    let vectors = buffers.iter().take(limit).map(|value| match value {
        Val::Bytes(bytes) => Ok(libc::iovec { iov_base: bytes.as_ptr().cast_mut().cast(), iov_len: bytes.len() }),
        _ => Err(NativeError::type_error("expected a byte buffer")),
    }).collect::<Result<Vec<_>, _>>()?;
    let count = libc::c_int::try_from(vectors.len()).map_err(|_| NativeError::range_error("too many buffers"))?;
    let files = state.fds.borrow();
    let descriptor = match fd {
        1 | 2 => { state.flush(); fd }
        _ => libc::c_int::try_from(files.files.get(&fd).ok_or_else(|| bad_fd("writev"))?.as_raw_fd())
            .map_err(|_| bad_fd("writev"))?,
    };
    let position = args.opt_num(2).filter(|&n| n >= 0.0).map(|n| n as libc::off_t);
    // The argument frame owns the byte buffers and the file table owns the descriptor until this synchronous call returns.
    let written = unsafe { match position {
        Some(position) => libc::pwritev(descriptor, vectors.as_ptr(), count, position),
        None => libc::writev(descriptor, vectors.as_ptr(), count),
    } };
    if written < 0 {
        return Err(io_error(io::Error::last_os_error(), "writev", None));
    }
    Ok(Val::Num(written as f64))
}

fn install_fds(t: &mut Table, state: &Rc<State>) {
    let st = state.clone();
    t.add("open", move |a| {
        let path = a.str(0)?;
        let flags = a.opt_str(1).unwrap_or("r");
        let file = open_options(flags).open(path).map_err(|e| io_error(e, "open", Some(path)))?;
        let mut fds = st.fds.borrow_mut();
        let fd = fds.next.max(3);
        fds.next = fd + 1;
        fds.files.insert(fd, file);
        Ok(fd.into())
    });
    let st = state.clone();
    t.add("close", move |a| {
        let fd = a.i32(0)?;
        if fd <= 2 {
            return ok();
        }
        match st.fds.borrow_mut().files.remove(&fd) {
            Some(_) => ok(),
            None => Err(bad_fd("close")),
        }
    });
    let st = state.clone();
    t.add("read", move |a| {
        let fd = a.i32(0)?;
        let mut buf = vec![0u8; a.num(1)? as usize];
        if fd == 0 && buf.is_empty() {
            return Ok(Val::Bytes(buf));
        }
        let n = if fd == 0 {
            io::stdin().read(&mut buf)
        } else {
            let mut fds = st.fds.borrow_mut();
            let file = fds.files.get_mut(&fd).ok_or_else(|| bad_fd("read"))?;
            if let Some(p) = a.opt_num(2).filter(|p| *p >= 0.0) {
                file.seek(SeekFrom::Start(p as u64)).map_err(|e| io_error(e, "read", None))?;
            }
            file.read(&mut buf)
        };
        let n = n.map_err(|e| io_error(e, "read", None))?;
        buf.truncate(n);
        Ok(Val::Bytes(buf))
    });
    let st = state.clone();
    t.add("write", move |a| {
        let fd = a.i32(0)?;
        let bytes = a.bytes(1)?;
        match fd {
            1 => st.write_stdout(bytes),
            2 => st.write_stderr(bytes),
            _ => {
                let mut fds = st.fds.borrow_mut();
                let file = fds.files.get_mut(&fd).ok_or_else(|| bad_fd("write"))?;
                let position = a.opt_num(2).filter(|p| *p >= 0.0).map(|p| p as u64);
                write_file_at(file, bytes, position).map_err(|e| io_error(e, "write", None))?;
            }
        }
        Ok(Val::Num(bytes.len() as f64))
    });
    let st = state.clone();
    t.add("writev", move |a| writev(&st, a));
    let st = state.clone();
    t.add("fstat", move |a| {
        let fds = st.fds.borrow();
        let file = fds.files.get(&a.i32(0)?).ok_or_else(|| bad_fd("fstat"))?;
        let meta = file.metadata().map_err(|e| io_error(e, "fstat", None))?;
        Ok(stat_record(&meta))
    });
    let st = state.clone();
    t.add("ftruncate", move |a| {
        let fds = st.fds.borrow();
        let file = fds.files.get(&a.i32(0)?).ok_or_else(|| bad_fd("ftruncate"))?;
        file.set_len(a.opt_num(1).unwrap_or(0.0) as u64).map_err(|e| io_error(e, "ftruncate", None))?;
        ok()
    });
}

fn install_modules(t: &mut Table, state: &Rc<State>) {
    let st = state.clone();
    t.add("resolve", move |a| {
        let spec = a.str(0)?;
        let kind = if a.bool(2) { Kind::Require } else { Kind::Import };
        match st.resolver.resolve(spec, a.str(1)?, kind) {
            Ok(Resolved::Builtin(name)) => Ok(name.into()),
            Ok(Resolved::File(path)) => Ok(path.into()),
            Err(msg) => Err(crate::modules::resolve_error(&msg, spec, kind)),
        }
    });
    let st = state.clone();
    t.add("moduleFormat", move |a| Ok(st.load_source(a.str(0)?)?.1.name().into()));
    let st = state.clone();
    t.add("mapPosition", move |a| {
        let mapped = st.map_position(a.str(0)?, a.u32(1)?, a.u32(2)?);
        Ok(mapped.map_or(Val::Undefined, |(l, c)| Val::Array(vec![l.into(), c.into()])))
    });
    let st = state.clone();
    t.add("getSourceLine", move |a| Ok(st.source_line(a.str(0)?, a.num(1)? as usize).into()));
    // `Bun.build`: the options as JSON (src/js/bun.js normalizes them), the
    // outputs as `{ outputs: [{ path, kind, contents }], logs }`.
    let st = state.clone();
    t.add("build", move |a| {
        let request = build_request(a.str(0)?)?;
        let result = st.transpiler.build(&request).map_err(|log| NativeError::error(log).prop("code", "BUILD_FAILED"))?;
        let outputs = result
            .outputs
            .into_iter()
            .map(|o| Record::new().set("path", o.path).set("kind", o.kind).set("contents", Val::Bytes(o.contents)).into())
            .collect();
        Ok(Record::new().set("outputs", Val::Array(outputs)).set("logs", result.logs).into())
    });
    let st = state.clone();
    t.add("devServerOpen", move |a| {
        st.transpiler.dev_server_open(a.str(0)?).map(dev_server_record).map_err(NativeError::error)
    });
    let st = state.clone();
    t.add("devServerRebuild", move |a| {
        let changed: Vec<String> = serde_json::from_str(a.str(1)?)
            .map_err(|error| NativeError::type_error(error.to_string()))?;
        st.transpiler.dev_server_rebuild(a.u32(0)?, &changed).map(dev_server_record).map_err(NativeError::error)
    });
    let st = state.clone();
    t.add("devServerClose", move |a| {
        st.transpiler.dev_server_close(a.u32(0)?);
        ok()
    });
}

fn dev_server_record(result: crate::DevServerResult) -> Val {
    let files = result.files.into_iter().map(|file| {
        Record::new().set("path", file.path).set("contents", Val::Bytes(file.contents)).set("type", file.mime).into()
    }).collect();
    Record::new()
        .set("id", result.id)
        .set("version", result.version)
        .set("html", Val::Bytes(result.html))
        .set("files", Val::Array(files))
        .set("watch", Val::Array(result.watch.into_iter().map(Val::Str).collect()))
        .set("update", Val::Bytes(result.update))
        .set("errors", Val::Bytes(result.errors))
        .set("logs", result.logs)
        .into()
}

fn build_request(json: &str) -> Result<crate::BuildRequest, NativeError> {
    use serde_json::Value as Json;
    let v: Json = serde_json::from_str(json).map_err(|e| NativeError::type_error(format!("Bun.build: {e}")))?;
    let text = |k: &str| v.get(k).and_then(Json::as_str).map(str::to_owned);
    let flag = |k: &str| v.get(k).and_then(Json::as_bool).unwrap_or(false);
    let list = |k: &str| -> Vec<String> {
        v.get(k).and_then(Json::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default()
    };
    let define = v
        .get("define")
        .and_then(Json::as_object)
        .map(|m| m.iter().filter_map(|(k, x)| x.as_str().map(|x| (k.clone(), x.to_owned()))).collect())
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
    t.add("utf8Encode", |a| Ok(Val::Bytes(a.str(0)?.as_bytes().to_vec())));
    t.add("utf8Decode", |a| {
        let bytes = a.bytes(0)?;
        match std::str::from_utf8(bytes) {
            Ok(s) => Ok(s.into()),
            Err(_) if a.bool(1) => Err(NativeError::type_error("The encoded data was not valid for encoding utf-8")),
            Err(_) => Ok(String::from_utf8_lossy(bytes).into_owned().into()),
        }
    });
    t.add("latin1Decode", |a| Ok(a.bytes(0)?.iter().map(|&b| char::from(b)).collect::<String>().into()));
    t.add("utf16leDecode", |a| {
        let units: Vec<u16> = a.bytes(0)?.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        Ok(String::from_utf16_lossy(&units).into())
    });
    t.add("base64Encode", |a| Ok(crate::encoding::base64_encode(a.bytes(0)?, a.bool(1)).into()));
    t.add("base64Decode", |a| Ok(Val::Bytes(crate::encoding::base64_decode(a.str(0)?))));
}

fn install_crypto(t: &mut Table) {
    t.add("randomBytes", |a| {
        let mut buf = vec![0u8; a.num(0)? as usize];
        getrandom::fill(&mut buf).map_err(|e| NativeError::error(e.to_string()))?;
        Ok(Val::Bytes(buf))
    });
    t.add("hash", |a| {
        let alg = a.str(0)?;
        let digest = crate::encoding::digest(alg, a.bytes(1)?)
            .ok_or_else(|| NativeError::type_error(format!("Digest method not supported: {alg}")))?;
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
    t.add("compress", |a| {
        let format = a.str(2)?;
        let wrapper = crate::encoding::Wrapper::parse(format)
            .ok_or_else(|| NativeError::type_error(format!("unknown compression format {format}")))?;
        let level = a.num(1)?;
        let level = if level < 0.0 { 6 } else { level.min(10.0) as u8 };
        Ok(Val::Bytes(crate::encoding::compress(a.bytes(0)?, level, wrapper)))
    });
    t.add("decompress", |a| {
        let format = a.str(1)?;
        let wrapper = crate::encoding::Wrapper::parse(format)
            .ok_or_else(|| NativeError::type_error(format!("unknown compression format {format}")))?;
        crate::encoding::decompress(a.bytes(0)?, wrapper)
            .map(Val::Bytes)
            .map_err(|msg| NativeError::error(msg).prop("code", "Z_DATA_ERROR").prop("errno", -3))
    });
    t.add("crc32", |a| Ok(Val::Num(f64::from(crate::encoding::crc32(a.bytes(0)?)))));
    t.add("adler32", |a| Ok(Val::Num(f64::from(crate::encoding::adler32(a.bytes(0)?)))));
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
        url.query().filter(|q| !q.is_empty()).map(|q| format!("?{q}")).unwrap_or_default(),
        url.fragment().filter(|f| !f.is_empty()).map(|f| format!("#{f}")).unwrap_or_default(),
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
        let Ok(mut url) = url::Url::parse(a.str(0)?) else { return ok() };
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
fn install_host(t: &mut Table) {
    use crate::host;
    let caps = host::SLOT_NAMES
        .iter()
        .enumerate()
        .map(|(i, name)| ((*name).to_owned(), Val::Bool(host::provided(i))))
        .collect();
    t.constants.push(("hostCaps", Val::Object(caps)));
    // String on success, the negative code otherwise.
    fn text_or_code(result: Result<Vec<u8>, i32>) -> NativeResult {
        Ok(match result {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned().into(),
            Err(code) => code.into(),
        })
    }
    t.add("hostSpawn", |a| Ok(host::spawn(a.str(0)?.as_bytes()).into()));
    t.add("hostChildWait", |a| Ok(host::child_wait(a.i32(0)?).into()));
    t.add("hostChildPipe", |a| Ok(host::child_pipe(a.i32(0)?, a.i32(1)?).into()));
    t.add("hostChildKill", |a| Ok(host::child_kill(a.i32(0)?, a.i32(1)?).into()));
    t.add("hostPoll", |a| Ok(host::poll(a.i32(0)?).into()));
    t.add("hostFetch", |a| {
        let body = if a.is_missing(1) { &[][..] } else { a.bytes(1)? };
        Ok(host::fetch(a.str(0)?.as_bytes(), body).into())
    });
    t.add("hostFetchHead", |a| text_or_code(host::fetch_head(a.i32(0)?)));
    t.add("hostError", |a| text_or_code(host::error(a.i32(0)?)));
    t.add("hostPeerAddr", |a| text_or_code(host::peer_addr(a.i32(0)?)));
    t.add("hostRead", |a| {
        let cap = a.opt_num(1).unwrap_or(65536.0).max(1.0) as usize;
        Ok(match host::read(a.i32(0)?, cap) {
            Ok(bytes) if bytes.is_empty() => 0.into(),
            Ok(bytes) => Val::Bytes(bytes),
            Err(code) => code.into(),
        })
    });
    t.add("hostWrite", |a| Ok(host::write(a.i32(0)?, a.bytes(1)?).into()));
    t.add("hostClose", |a| Ok(host::close(a.i32(0)?).into()));
    t.add("hostListen", |a| Ok(host::listen(a.str(0)?, a.i32(1)?).into()));
    t.add("hostLocalPort", |a| Ok(host::local_port(a.i32(0)?).into()));
    t.add("hostAccept", |a| Ok(host::accept(a.i32(0)?).into()));
    t.add("hostConnect", |a| Ok(host::connect(a.str(0)?, a.i32(1)?).into()));
}

fn platform_info() -> Val {
    Record::new()
        .set("version", crate::BUN_VERSION)
        .set("revision", crate::BUN_REVISION)
        .set("arch", if cfg!(target_arch = "wasm32") { "wasm32" } else { std::env::consts::ARCH })
        .into()
}
