//! Native functions exposed to the JS side of the runtime as the `native`
//! object. The JS polyfills (src/js/*.js) build the public Bun/Node/Web APIs on
//! top of these; nothing here is reachable from user code directly.
//!
//! Conventions: byte buffers cross the boundary as `Uint8Array` (JS converts
//! other views first), paths are absolute strings, and failures throw
//! Node-style errors (`code`, `errno`, `syscall`, `path`).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rquickjs::function::{IntoJsFunc, Opt};
use rquickjs::object::Property;
use rquickjs::{
    qjs, Array, BigInt, Ctx, Exception, Function, IntoJs, Object, Promise, Result, TypedArray, Value,
};

use crate::modules;
use crate::resolve::{self, Kind, Resolved};
use crate::State;

unsafe extern "C" {
    /// Added to QuickJS by bun-wasm (third_party/rquickjs-sys): remaining
    /// entries of a Map/Set iterator, without advancing it.
    fn JS_bunwasm_IteratorEntries(ctx: *mut qjs::JSContext, value: qjs::JSValue) -> qjs::JSValue;
    /// Own keys in JSC's console order (index keys, then insertion order with
    /// symbols interleaved); undefined for exotic objects.
    fn JS_bunwasm_OwnKeysInOrder(ctx: *mut qjs::JSContext, value: qjs::JSValue) -> qjs::JSValue;
    /// The async context promise reactions capture and restore (new reference).
    fn JS_bunwasm_GetAsyncContext(ctx: *mut qjs::JSContext) -> qjs::JSValue;
    fn JS_bunwasm_SetAsyncContext(ctx: *mut qjs::JSContext, value: qjs::JSValue);
}

type EngineHelper = unsafe extern "C" fn(*mut qjs::JSContext, qjs::JSValue) -> qjs::JSValue;

/// Call one of the bun-wasm helpers added to QuickJS.
fn call_engine_helper<'js>(ctx: &Ctx<'js>, value: &Value<'js>, helper: EngineHelper) -> Result<Value<'js>> {
    // SAFETY: the helpers borrow `value` and return a new reference, or
    // JS_EXCEPTION with the exception left on the context.
    unsafe {
        let raw = helper(ctx.as_raw().as_ptr(), value.as_raw());
        if qjs::JS_IsException(raw) {
            return Err(rquickjs::Error::Exception);
        }
        Ok(Value::from_raw(ctx.clone(), raw))
    }
}

pub(crate) fn set_fn<'js, F, P>(obj: &Object<'js>, name: &str, f: F) -> Result<()>
where
    F: IntoJsFunc<'js, P> + 'js,
{
    let func = Function::new(obj.ctx().clone(), f)?.with_name(name)?;
    obj.set(name, func)
}

/// Bytes of a string (UTF-8) or a `Uint8Array` / `ArrayBuffer`.
pub fn bytes_of(value: &Value<'_>) -> Result<Vec<u8>> {
    if let Some(s) = value.as_string() {
        return Ok(s.to_string()?.into_bytes());
    }
    if let Ok(arr) = TypedArray::<u8>::from_value(value.clone()) {
        // SAFETY: no JS runs while the slice is alive; it is copied at once.
        return Ok(unsafe { arr.as_bytes() }.unwrap_or(&[]).to_vec());
    }
    if let Some(buf) = value.as_object().and_then(|o| rquickjs::ArrayBuffer::from_object(o.clone())) {
        // SAFETY: as above.
        return Ok(unsafe { buf.as_bytes() }.unwrap_or(&[]).to_vec());
    }
    Err(Exception::throw_type(value.ctx(), "expected a string, Uint8Array or ArrayBuffer"))
}

/// A plain `Error` with a non-enumerable `message`, as `new Error(message)`
/// makes it (`Exception::from_message` defines an enumerable one, which then
/// shows in `Object.keys(err)` and in inspected output).
pub fn new_error<'js>(ctx: &Ctx<'js>, message: &str) -> Result<Exception<'js>> {
    let err = Exception::from_message(ctx.clone(), message)?;
    // Redefining keeps the old enumerability, so delete first.
    err.as_object().remove("message")?;
    err.as_object().prop("message", Property::from(message).writable().configurable())?;
    Ok(err)
}

/// Throw [`new_error`].
pub fn throw_error(ctx: &Ctx<'_>, message: &str) -> rquickjs::Error {
    match new_error(ctx, message) {
        Ok(err) => err.throw(),
        Err(e) => e,
    }
}

fn uint8<'js>(ctx: &Ctx<'js>, bytes: Vec<u8>) -> Result<Value<'js>> {
    TypedArray::<u8>::new(ctx.clone(), bytes).map(|a| a.into_value())
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

pub fn throw_io(ctx: &Ctx<'_>, err: io::Error, syscall: &str, path: Option<&str>) -> rquickjs::Error {
    let (code, errno, desc) = errno_info(&err);
    let message = match path {
        Some(p) => format!("{code}: {desc}, {syscall} '{p}'"),
        None => format!("{code}: {desc}, {syscall}"),
    };
    let exception = match new_error(ctx, &message) {
        Ok(e) => e,
        Err(e) => return e,
    };
    let obj = exception.as_object();
    let attach = || -> Result<()> {
        if let Some(p) = path {
            obj.set("path", p)?;
        }
        obj.set("syscall", syscall)?;
        obj.set("errno", errno)?;
        obj.set("code", code)?;
        Ok(())
    };
    if let Err(e) = attach() {
        return e;
    }
    exception.throw()
}

fn millis(time: io::Result<SystemTime>) -> f64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn stat_object<'js>(ctx: &Ctx<'js>, meta: &fs::Metadata) -> Result<Object<'js>> {
    let ft = meta.file_type();
    let (kind_bits, perm) = if ft.is_dir() {
        (0o040000, 0o755)
    } else if ft.is_symlink() {
        (0o120000, 0o777)
    } else {
        (0o100000, 0o644)
    };
    let obj = Object::new(ctx.clone())?;
    let (dev, ino, nlink) = inode_info(meta);
    obj.set("dev", dev)?;
    obj.set("ino", ino)?;
    obj.set("mode", kind_bits | perm)?;
    obj.set("nlink", nlink)?;
    obj.set("uid", 0)?;
    obj.set("gid", 0)?;
    obj.set("rdev", 0)?;
    obj.set("size", meta.len() as f64)?;
    obj.set("blksize", 4096)?;
    obj.set("blocks", meta.len().div_ceil(512) as f64)?;
    let mtime = millis(meta.modified());
    obj.set("atimeMs", millis(meta.accessed()))?;
    obj.set("mtimeMs", mtime)?;
    obj.set("ctimeMs", mtime)?;
    obj.set("birthtimeMs", millis(meta.created()))?;
    Ok(obj)
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

pub fn install<'js>(ctx: &Ctx<'js>, state: &Rc<State>) -> Result<Object<'js>> {
    let native = Object::new(ctx.clone())?;
    install_process(&native, state)?;
    install_fs(&native)?;
    install_fds(&native, state)?;
    install_modules(&native, state)?;
    install_encoding(&native)?;
    install_crypto(&native)?;
    install_url(&native)?;
    install_engine(&native, state)?;
    install_host(&native)?;
    crate::sqlite::install(&native)?;
    Ok(native)
}

fn install_process<'js>(native: &Object<'js>, state: &Rc<State>) -> Result<()> {
    let st = state.clone();
    set_fn(native, "writeStdout", move |data: Value<'js>| -> Result<()> {
        let bytes = bytes_of(&data)?;
        st.write_stdout(&bytes);
        Ok(())
    })?;
    let st = state.clone();
    set_fn(native, "writeStderr", move |data: Value<'js>| -> Result<()> {
        let bytes = bytes_of(&data)?;
        st.write_stderr(&bytes);
        Ok(())
    })?;
    let st = state.clone();
    set_fn(native, "exit", move |code: Opt<i32>| -> Result<()> {
        st.exit(code.0.unwrap_or(0));
    })?;
    let st = state.clone();
    set_fn(native, "argv", move |ctx: Ctx<'js>| -> Result<Array<'js>> {
        let arr = Array::new(ctx)?;
        for (i, arg) in st.argv.iter().enumerate() {
            arr.set(i, arg.as_str())?;
        }
        Ok(arr)
    })?;
    let st = state.clone();
    set_fn(native, "mainPath", move || -> String { st.main.borrow().clone() })?;
    let st = state.clone();
    set_fn(native, "setMainPath", move |path: String| *st.main.borrow_mut() = path)?;
    let st = state.clone();
    set_fn(native, "mainArg", move || -> String { st.main_arg.borrow().clone() })?;
    set_fn(native, "env", |ctx: Ctx<'js>| -> Result<Object<'js>> {
        let obj = Object::new(ctx)?;
        for (k, v) in std::env::vars_os() {
            obj.set(k.to_string_lossy().as_ref(), v.to_string_lossy().as_ref())?;
        }
        Ok(obj)
    })?;
    set_fn(native, "cwd", || -> String {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .ok()
            .filter(|p| p.starts_with('/'))
            .unwrap_or_else(|| "/".to_owned())
    })?;
    set_fn(native, "chdir", |ctx: Ctx<'js>, path: String| -> Result<()> {
        std::env::set_current_dir(&path).map_err(|e| throw_io(&ctx, e, "chdir", Some(&path)))
    })?;
    let st = state.clone();
    set_fn(native, "now", move || -> f64 { st.start.elapsed().as_secs_f64() * 1000.0 })?;
    let st = state.clone();
    set_fn(native, "nanoseconds", move || -> f64 { st.start.elapsed().as_nanos() as f64 })?;
    set_fn(native, "timeOrigin", || -> f64 { millis(Ok(SystemTime::now())) })?;
    let st = state.clone();
    set_fn(native, "sleep", move |ms: f64| {
        st.flush();
        if ms > 0.0 {
            std::thread::sleep(Duration::from_secs_f64(ms / 1000.0));
        }
    })?;
    set_fn(native, "isatty", |fd: i32| -> bool {
        use std::io::IsTerminal;
        match fd {
            0 => io::stdin().is_terminal(),
            1 => io::stdout().is_terminal(),
            2 => io::stderr().is_terminal(),
            _ => false,
        }
    })?;
    set_fn(native, "readStdin", |ctx: Ctx<'js>| -> Result<Value<'js>> {
        let mut buf = Vec::new();
        io::stdin().read_to_end(&mut buf).map_err(|e| throw_io(&ctx, e, "read", None))?;
        uint8(&ctx, buf)
    })?;
    Ok(())
}

fn install_fs<'js>(native: &Object<'js>) -> Result<()> {
    set_fn(native, "readFile", |ctx: Ctx<'js>, path: String| -> Result<Value<'js>> {
        let bytes = fs::read(&path).map_err(|e| throw_io(&ctx, e, "open", Some(&path)))?;
        uint8(&ctx, bytes)
    })?;
    set_fn(native, "readFileUtf8", |ctx: Ctx<'js>, path: String| -> Result<String> {
        let bytes = fs::read(&path).map_err(|e| throw_io(&ctx, e, "open", Some(&path)))?;
        Ok(String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
    })?;
    set_fn(native, "writeFile", |ctx: Ctx<'js>, path: String, data: Value<'js>, append: Opt<bool>| -> Result<f64> {
        let bytes = bytes_of(&data)?;
        let opts = open_options(if append.0.unwrap_or(false) { "a" } else { "w" });
        let mut file = opts.open(&path).map_err(|e| throw_io(&ctx, e, "open", Some(&path)))?;
        file.write_all(&bytes).map_err(|e| throw_io(&ctx, e, "write", Some(&path)))?;
        Ok(bytes.len() as f64)
    })?;
    set_fn(native, "exists", |path: String| fs::symlink_metadata(&path).is_ok())?;
    set_fn(native, "stat", |ctx: Ctx<'js>, path: String, lstat: Opt<bool>| -> Result<Object<'js>> {
        let lstat = lstat.0.unwrap_or(false);
        let meta = if lstat { fs::symlink_metadata(&path) } else { fs::metadata(&path) };
        let meta = meta.map_err(|e| throw_io(&ctx, e, if lstat { "lstat" } else { "stat" }, Some(&path)))?;
        stat_object(&ctx, &meta)
    })?;
    set_fn(native, "mkdir", |ctx: Ctx<'js>, path: String, recursive: Opt<bool>| -> Result<Option<String>> {
        if !recursive.0.unwrap_or(false) {
            fs::create_dir(&path).map_err(|e| throw_io(&ctx, e, "mkdir", Some(&path)))?;
            return Ok(None);
        }
        // Node returns the first directory actually created.
        let mut first = None;
        let mut current = String::new();
        for part in path.split('/').filter(|p| !p.is_empty()) {
            current = format!("{current}/{part}");
            if fs::metadata(&current).is_ok() {
                continue;
            }
            fs::create_dir(&current).map_err(|e| throw_io(&ctx, e, "mkdir", Some(&path)))?;
            first.get_or_insert_with(|| current.clone());
        }
        Ok(first)
    })?;
    set_fn(native, "readdir", |ctx: Ctx<'js>, path: String| -> Result<Array<'js>> {
        let entries = fs::read_dir(&path).map_err(|e| throw_io(&ctx, e, "scandir", Some(&path)))?;
        let mut list: Vec<(String, &str)> = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| throw_io(&ctx, e, "scandir", Some(&path)))?;
            let kind = match entry.file_type() {
                Ok(t) if t.is_dir() => "dir",
                Ok(t) if t.is_symlink() => "symlink",
                Ok(t) if t.is_file() => "file",
                _ => "other",
            };
            list.push((entry.file_name().to_string_lossy().into_owned(), kind));
        }
        // Host directory order, like Node (no sorting).
        let arr = Array::new(ctx.clone())?;
        for (i, (name, kind)) in list.into_iter().enumerate() {
            let pair = Array::new(ctx.clone())?;
            pair.set(0, name)?;
            pair.set(1, kind)?;
            arr.set(i, pair)?;
        }
        Ok(arr)
    })?;
    set_fn(native, "rm", |ctx: Ctx<'js>, path: String, recursive: Opt<bool>, force: Opt<bool>| -> Result<()> {
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) if force.0.unwrap_or(false) => return Ok(()),
            Err(e) => return Err(throw_io(&ctx, e, "rm", Some(&path))),
        };
        let result = match (meta.is_dir(), recursive.0.unwrap_or(false)) {
            (true, true) => fs::remove_dir_all(&path),
            (true, false) => Err(io::Error::from(io::ErrorKind::IsADirectory)),
            _ => fs::remove_file(&path),
        };
        result.map_err(|e| throw_io(&ctx, e, "rm", Some(&path)))
    })?;
    set_fn(native, "rmdir", |ctx: Ctx<'js>, path: String, recursive: Opt<bool>| -> Result<()> {
        let result = if recursive.0.unwrap_or(false) { fs::remove_dir_all(&path) } else { fs::remove_dir(&path) };
        result.map_err(|e| throw_io(&ctx, e, "rmdir", Some(&path)))
    })?;
    set_fn(native, "unlink", |ctx: Ctx<'js>, path: String| -> Result<()> {
        fs::remove_file(&path).map_err(|e| throw_io(&ctx, e, "unlink", Some(&path)))
    })?;
    set_fn(native, "rename", |ctx: Ctx<'js>, from: String, to: String| -> Result<()> {
        fs::rename(&from, &to).map_err(|e| throw_io(&ctx, e, "rename", Some(&from)))
    })?;
    set_fn(native, "copyFile", |ctx: Ctx<'js>, from: String, to: String| -> Result<()> {
        fs::copy(&from, &to).map(|_| ()).map_err(|e| throw_io(&ctx, e, "copyfile", Some(&from)))
    })?;
    set_fn(native, "copyDir", |ctx: Ctx<'js>, from: String, to: String| -> Result<()> {
        copy_dir_all(&from, &to).map_err(|e| throw_io(&ctx, e, "cp", Some(&from)))
    })?;
    set_fn(native, "realpath", |ctx: Ctx<'js>, path: String| -> Result<String> {
        fs::canonicalize(&path)
            .map(|p| p.to_string_lossy().into_owned())
            .or_else(|e| match fs::metadata(&path) {
                // WASI has no realpath; a lexically normalized path is the best we can do.
                Ok(_) => Ok(resolve::normalize(&path)),
                Err(_) => Err(e),
            })
            .map_err(|e| throw_io(&ctx, e, "realpath", Some(&path)))
    })?;
    set_fn(native, "readlink", |ctx: Ctx<'js>, path: String| -> Result<String> {
        fs::read_link(&path)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| throw_io(&ctx, e, "readlink", Some(&path)))
    })?;
    set_fn(native, "symlink", |ctx: Ctx<'js>, target: String, path: String| -> Result<()> {
        symlink(&target, &path).map_err(|e| throw_io(&ctx, e, "symlink", Some(&path)))
    })?;
    set_fn(native, "link", |ctx: Ctx<'js>, from: String, to: String| -> Result<()> {
        fs::hard_link(&from, &to).map_err(|e| throw_io(&ctx, e, "link", Some(&from)))
    })?;
    set_fn(native, "truncate", |ctx: Ctx<'js>, path: String, len: Opt<f64>| -> Result<()> {
        let file = OpenOptions::new().write(true).open(&path).map_err(|e| throw_io(&ctx, e, "open", Some(&path)))?;
        file.set_len(len.0.unwrap_or(0.0) as u64).map_err(|e| throw_io(&ctx, e, "ftruncate", Some(&path)))
    })?;
    Ok(())
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

fn install_fds<'js>(native: &Object<'js>, state: &Rc<State>) -> Result<()> {
    let st = state.clone();
    set_fn(native, "open", move |ctx: Ctx<'js>, path: String, flags: Opt<String>| -> Result<i32> {
        let flags = flags.0.unwrap_or_else(|| "r".to_owned());
        let file = open_options(&flags).open(&path).map_err(|e| throw_io(&ctx, e, "open", Some(&path)))?;
        let mut fds = st.fds.borrow_mut();
        let fd = fds.next.max(3);
        fds.next = fd + 1;
        fds.files.insert(fd, file);
        Ok(fd)
    })?;
    let st = state.clone();
    set_fn(native, "close", move |ctx: Ctx<'js>, fd: i32| -> Result<()> {
        if fd <= 2 {
            return Ok(());
        }
        match st.fds.borrow_mut().files.remove(&fd) {
            Some(_) => Ok(()),
            None => Err(throw_io(&ctx, io::Error::from_raw_os_error(8), "close", None)),
        }
    })?;
    let st = state.clone();
    set_fn(native, "read", move |ctx: Ctx<'js>, fd: i32, len: f64, pos: Opt<f64>| -> Result<Value<'js>> {
        let mut buf = vec![0u8; len as usize];
        let n = if fd == 0 {
            io::stdin().read(&mut buf)
        } else {
            let mut fds = st.fds.borrow_mut();
            let file = fds.files.get_mut(&fd).ok_or_else(|| bad_fd(&ctx, "read"))?;
            if let Some(p) = pos.0.filter(|p| *p >= 0.0) {
                file.seek(SeekFrom::Start(p as u64)).map_err(|e| throw_io(&ctx, e, "read", None))?;
            }
            file.read(&mut buf)
        };
        let n = n.map_err(|e| throw_io(&ctx, e, "read", None))?;
        buf.truncate(n);
        uint8(&ctx, buf)
    })?;
    let st = state.clone();
    set_fn(native, "write", move |ctx: Ctx<'js>, fd: i32, data: Value<'js>, pos: Opt<f64>| -> Result<f64> {
        let bytes = bytes_of(&data)?;
        match fd {
            1 => st.write_stdout(&bytes),
            2 => st.write_stderr(&bytes),
            _ => {
                let mut fds = st.fds.borrow_mut();
                let file = fds.files.get_mut(&fd).ok_or_else(|| bad_fd(&ctx, "write"))?;
                if let Some(p) = pos.0.filter(|p| *p >= 0.0) {
                    file.seek(SeekFrom::Start(p as u64)).map_err(|e| throw_io(&ctx, e, "write", None))?;
                }
                file.write_all(&bytes).map_err(|e| throw_io(&ctx, e, "write", None))?;
            }
        }
        Ok(bytes.len() as f64)
    })?;
    let st = state.clone();
    set_fn(native, "fstat", move |ctx: Ctx<'js>, fd: i32| -> Result<Object<'js>> {
        let fds = st.fds.borrow();
        let file = fds.files.get(&fd).ok_or_else(|| bad_fd(&ctx, "fstat"))?;
        let meta = file.metadata().map_err(|e| throw_io(&ctx, e, "fstat", None))?;
        stat_object(&ctx, &meta)
    })?;
    let st = state.clone();
    set_fn(native, "ftruncate", move |ctx: Ctx<'js>, fd: i32, len: Opt<f64>| -> Result<()> {
        let fds = st.fds.borrow();
        let file = fds.files.get(&fd).ok_or_else(|| bad_fd(&ctx, "ftruncate"))?;
        file.set_len(len.0.unwrap_or(0.0) as u64).map_err(|e| throw_io(&ctx, e, "ftruncate", None))
    })?;
    Ok(())
}

fn bad_fd(ctx: &Ctx<'_>, syscall: &str) -> rquickjs::Error {
    let err = new_error(ctx, &format!("EBADF: bad file descriptor, {syscall}"));
    match err {
        Ok(e) => {
            let _ = e.as_object().set("syscall", syscall);
            let _ = e.as_object().set("errno", -9);
            let _ = e.as_object().set("code", "EBADF");
            e.throw()
        }
        Err(e) => e,
    }
}

fn install_modules<'js>(native: &Object<'js>, state: &Rc<State>) -> Result<()> {
    let st = state.clone();
    set_fn(native, "resolve", move |ctx: Ctx<'js>, spec: String, from: String, require: Opt<bool>| -> Result<String> {
        let kind = if require.0.unwrap_or(false) { Kind::Require } else { Kind::Import };
        match st.resolver.resolve(&spec, &from, kind) {
            Ok(Resolved::Builtin(name)) => Ok(name),
            Ok(Resolved::File(path)) => Ok(path),
            Err(msg) => Err(modules::throw_resolve_error(&ctx, &msg, &spec, kind)),
        }
    })?;
    let st = state.clone();
    set_fn(native, "moduleFormat", move |ctx: Ctx<'js>, path: String| -> Result<&'static str> {
        modules::module_format(&ctx, &st, &path)
    })?;
    let st = state.clone();
    set_fn(native, "compileCjs", move |ctx: Ctx<'js>, path: String| -> Result<Function<'js>> {
        modules::compile_cjs(&ctx, &st, &path)
    })?;
    let st = state.clone();
    set_fn(native, "requireEsm", move |ctx: Ctx<'js>, path: String| -> Result<Value<'js>> {
        modules::require_esm(&ctx, &st, &path)
    })?;
    set_fn(native, "importModule", |ctx: Ctx<'js>, spec: String| -> Result<Promise<'js>> {
        rquickjs::Module::import(&ctx, spec)
    })?;
    set_fn(native, "evalScript", |ctx: Ctx<'js>, code: String, filename: Opt<String>| -> Result<Value<'js>> {
        let mut opts = rquickjs::context::EvalOptions::default();
        opts.global = true;
        opts.strict = false;
        opts.filename = Some(filename.0.unwrap_or_else(|| "evalmachine.<anonymous>".to_owned()));
        ctx.eval_with_options(code, opts)
    })?;
    set_fn(native, "loadPolyfill", |ctx: Ctx<'js>, name: String| -> Result<Value<'js>> {
        modules::load_polyfill(&ctx, &name)
    })?;
    let st = state.clone();
    set_fn(native, "mapPosition", move |ctx: Ctx<'js>, file: String, line: u32, col: u32| -> Result<Value<'js>> {
        let Some((line, col)) = st.map_position(&file, line, col) else {
            return Ok(Value::new_undefined(ctx));
        };
        let pair = Array::new(ctx.clone())?;
        pair.set(0, line)?;
        pair.set(1, col)?;
        Ok(pair.into_value())
    })?;
    let st = state.clone();
    set_fn(native, "getSourceLine", move |file: String, line: f64| -> Option<String> {
        st.source_line(&file, line as usize)
    })?;
    Ok(())
}

fn install_encoding<'js>(native: &Object<'js>) -> Result<()> {
    set_fn(native, "utf8Encode", |ctx: Ctx<'js>, s: String| uint8(&ctx, s.into_bytes()))?;
    set_fn(native, "utf8Decode", |ctx: Ctx<'js>, data: Value<'js>, fatal: Opt<bool>| -> Result<String> {
        let bytes = bytes_of(&data)?;
        match String::from_utf8(bytes) {
            Ok(s) => Ok(s),
            Err(_) if fatal.0.unwrap_or(false) => Err(Exception::throw_type(
                &ctx,
                "The encoded data was not valid for encoding utf-8",
            )),
            Err(e) => Ok(String::from_utf8_lossy(e.as_bytes()).into_owned()),
        }
    })?;
    set_fn(native, "latin1Decode", |data: Value<'js>| -> Result<String> {
        Ok(bytes_of(&data)?.into_iter().map(char::from).collect())
    })?;
    set_fn(native, "utf16leDecode", |data: Value<'js>| -> Result<String> {
        let bytes = bytes_of(&data)?;
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        Ok(String::from_utf16_lossy(&units))
    })?;
    set_fn(native, "base64Encode", |data: Value<'js>, url: Opt<bool>| -> Result<String> {
        Ok(crate::encoding::base64_encode(&bytes_of(&data)?, url.0.unwrap_or(false)))
    })?;
    set_fn(native, "base64Decode", |ctx: Ctx<'js>, s: String| uint8(&ctx, crate::encoding::base64_decode(&s)))?;
    Ok(())
}

fn install_crypto<'js>(native: &Object<'js>) -> Result<()> {
    set_fn(native, "randomBytes", |ctx: Ctx<'js>, n: f64| -> Result<Value<'js>> {
        let mut buf = vec![0u8; n as usize];
        getrandom::fill(&mut buf).map_err(|e| Exception::throw_internal(&ctx, &e.to_string()))?;
        uint8(&ctx, buf)
    })?;
    set_fn(native, "hash", |ctx: Ctx<'js>, alg: String, data: Value<'js>| -> Result<Value<'js>> {
        let bytes = bytes_of(&data)?;
        let digest = crate::encoding::digest(&alg, &bytes)
            .ok_or_else(|| Exception::throw_type(&ctx, &format!("Digest method not supported: {alg}")))?;
        uint8(&ctx, digest)
    })?;
    set_fn(native, "hmac", |ctx: Ctx<'js>, alg: String, key: Value<'js>, data: Value<'js>| -> Result<Value<'js>> {
        let (key, bytes) = (bytes_of(&key)?, bytes_of(&data)?);
        let digest = crate::encoding::hmac(&alg, &key, &bytes)
            .ok_or_else(|| Exception::throw_type(&ctx, &format!("Invalid digest: {alg}")))?;
        uint8(&ctx, digest)
    })?;
    set_fn(native, "wyhash", |ctx: Ctx<'js>, data: Value<'js>, seed: Opt<f64>| -> Result<BigInt<'js>> {
        let bytes = bytes_of(&data)?;
        let seed = seed.0.unwrap_or(0.0) as u64;
        BigInt::from_u64(ctx, bun_wyhash::hash_with_seed(seed, &bytes))
    })?;
    set_fn(native, "compress", |ctx: Ctx<'js>, data: Value<'js>, level: f64, format: String| -> Result<Value<'js>> {
        let wrapper = crate::encoding::Wrapper::parse(&format)
            .ok_or_else(|| Exception::throw_type(&ctx, &format!("unknown compression format {format}")))?;
        let level = if level < 0.0 { 6 } else { level.min(10.0) as u8 };
        uint8(&ctx, crate::encoding::compress(&bytes_of(&data)?, level, wrapper))
    })?;
    set_fn(native, "decompress", |ctx: Ctx<'js>, data: Value<'js>, format: String| -> Result<Value<'js>> {
        let wrapper = crate::encoding::Wrapper::parse(&format)
            .ok_or_else(|| Exception::throw_type(&ctx, &format!("unknown compression format {format}")))?;
        match crate::encoding::decompress(&bytes_of(&data)?, wrapper) {
            Ok(out) => uint8(&ctx, out),
            Err(msg) => {
                let err = new_error(&ctx, &msg)?;
                err.as_object().set("code", "Z_DATA_ERROR")?;
                err.as_object().set("errno", -3)?;
                Err(err.throw())
            }
        }
    })?;
    set_fn(native, "crc32", |data: Value<'js>| -> Result<f64> {
        Ok(crate::encoding::crc32(&bytes_of(&data)?) as f64)
    })?;
    set_fn(native, "adler32", |data: Value<'js>| -> Result<f64> {
        Ok(crate::encoding::adler32(&bytes_of(&data)?) as f64)
    })?;
    Ok(())
}

/// URL components in the order the JS `URL` class expects.
fn url_parts<'js>(ctx: &Ctx<'js>, url: &url::Url) -> Result<Array<'js>> {
    let arr = Array::new(ctx.clone())?;
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
    for (i, part) in parts.into_iter().enumerate() {
        arr.set(i, part)?;
    }
    Ok(arr)
}

fn install_url<'js>(native: &Object<'js>) -> Result<()> {
    set_fn(native, "urlParse", |ctx: Ctx<'js>, input: String, base: Opt<String>| -> Result<Option<Array<'js>>> {
        let parsed = match base.0 {
            Some(base) => url::Url::parse(&base).and_then(|b| b.join(&input)),
            None => url::Url::parse(&input),
        };
        parsed.ok().map(|u| url_parts(&ctx, &u)).transpose()
    })?;
    set_fn(native, "urlSet", |ctx: Ctx<'js>, href: String, prop: String, value: String| -> Result<Option<Array<'js>>> {
        let Ok(mut url) = url::Url::parse(&href) else { return Ok(None) };
        // Setters that fail leave the URL unchanged, like the WHATWG spec says.
        let _ = match prop.as_str() {
            "protocol" => url.set_scheme(value.trim_end_matches(':')),
            "username" => url.set_username(&value),
            "password" => url.set_password(Some(&value).filter(|v| !v.is_empty()).map(|v| v.as_str())),
            "host" => url::quirks::set_host(&mut url, &value),
            "hostname" => url::quirks::set_hostname(&mut url, &value),
            "port" => url::quirks::set_port(&mut url, &value),
            "pathname" => {
                url::quirks::set_pathname(&mut url, &value);
                Ok(())
            }
            "search" => {
                url::quirks::set_search(&mut url, &value);
                Ok(())
            }
            "hash" => {
                url::quirks::set_hash(&mut url, &value);
                Ok(())
            }
            _ => Ok(()),
        };
        url_parts(&ctx, &url).map(Some)
    })?;
    set_fn(native, "domainToASCII", |s: String| -> String {
        url::Url::parse(&format!("http://{s}/")).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default()
    })?;
    Ok(())
}

fn install_engine<'js>(native: &Object<'js>, state: &Rc<State>) -> Result<()> {
    set_fn(native, "promiseState", |p: Value<'js>| -> &'static str {
        let Some(promise) = p.as_promise() else { return "fulfilled" };
        match promise.state() {
            rquickjs::promise::PromiseState::Pending => "pending",
            rquickjs::promise::PromiseState::Resolved => "fulfilled",
            rquickjs::promise::PromiseState::Rejected => "rejected",
        }
    })?;
    set_fn(native, "promiseResult", |ctx: Ctx<'js>, p: Promise<'js>| modules::promise_result(&ctx, &p))?;
    set_fn(native, "isProxy", |v: Value<'js>| v.is_proxy())?;
    set_fn(native, "iteratorEntries", |ctx: Ctx<'js>, v: Value<'js>| call_engine_helper(&ctx, &v, JS_bunwasm_IteratorEntries))?;
    set_fn(native, "ownKeysInOrder", |ctx: Ctx<'js>, v: Value<'js>| call_engine_helper(&ctx, &v, JS_bunwasm_OwnKeysInOrder))?;
    // SAFETY: plain accessors on the context's async-context slot.
    set_fn(native, "getAsyncContext", |ctx: Ctx<'js>| unsafe {
        Value::from_raw(ctx.clone(), JS_bunwasm_GetAsyncContext(ctx.as_raw().as_ptr()))
    })?;
    set_fn(native, "setAsyncContext", |ctx: Ctx<'js>, v: Value<'js>| unsafe {
        JS_bunwasm_SetAsyncContext(ctx.as_raw().as_ptr(), v.as_raw())
    })?;
    set_fn(native, "isPromise", |v: Value<'js>| v.is_promise())?;
    // SAFETY: JS_IsError only inspects the value's class.
    set_fn(native, "isError", |v: Value<'js>| unsafe { qjs::JS_IsError(v.as_raw()) })?;
    set_fn(native, "getProxyTarget", |ctx: Ctx<'js>, v: Value<'js>| -> Result<Value<'js>> {
        if !v.is_proxy() {
            return Ok(Value::new_undefined(ctx));
        }
        // SAFETY: returns a new reference to the proxy's target.
        unsafe {
            let raw = qjs::JS_GetProxyTarget(ctx.as_raw().as_ptr(), v.as_raw());
            Ok(Value::from_raw(ctx.clone(), raw))
        }
    })?;
    let st = state.clone();
    set_fn(native, "scheduleTick", move || st.tick_pending.set(true))?;
    let st = state.clone();
    set_fn(native, "runMicrotasks", move |ctx: Ctx<'js>| -> Result<()> {
        st.drain_jobs(&ctx);
        Ok(())
    })?;
    set_fn(native, "gc", |ctx: Ctx<'js>| ctx.run_gc())?;
    set_fn(native, "memoryUsage", |ctx: Ctx<'js>| -> Result<Object<'js>> {
        let mut usage = std::mem::MaybeUninit::<qjs::JSMemoryUsage>::zeroed();
        // SAFETY: the runtime pointer is live for the duration of this call.
        let usage = unsafe {
            qjs::JS_ComputeMemoryUsage(qjs::JS_GetRuntime(ctx.as_raw().as_ptr()), usage.as_mut_ptr());
            usage.assume_init()
        };
        let obj = Object::new(ctx.clone())?;
        let heap = usage.malloc_size as f64;
        obj.set("rss", wasm_memory_bytes().max(heap))?;
        obj.set("heapTotal", usage.malloc_limit.max(usage.malloc_size) as f64)?;
        obj.set("heapUsed", usage.memory_used_size as f64)?;
        obj.set("external", 0)?;
        obj.set("arrayBuffers", 0)?;
        Ok(obj)
    })?;
    native.set("platformInfo", platform_info(native.ctx())?)?;
    Ok(())
}

/// The `bun_wasm` host ABI (docs/host-abi.md) for the JS networking layer
/// (src/js/net.js). Functions return the ABI's raw codes (negative = error);
/// byte results come back as Uint8Array / strings.
fn install_host<'js>(native: &Object<'js>) -> Result<()> {
    use crate::host;
    let ctx = native.ctx().clone();
    let caps = Object::new(ctx)?;
    for (i, name) in host::SLOT_NAMES.iter().enumerate() {
        caps.set(*name, host::provided(i))?;
    }
    native.set("hostCaps", caps)?;
    set_fn(native, "hostPoll", |timeout: i32| host::poll(timeout))?;
    set_fn(native, "hostFetch", |meta: String, body: Value<'js>| -> Result<i32> {
        let body = if body.is_undefined() || body.is_null() { Vec::new() } else { bytes_of(&body)? };
        Ok(host::fetch(meta.as_bytes(), &body))
    })?;
    // String on success, the negative code otherwise.
    fn text_or_code<'js>(ctx: &Ctx<'js>, result: std::result::Result<Vec<u8>, i32>) -> Result<Value<'js>> {
        match result {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned().into_js(ctx),
            Err(code) => Ok(Value::new_int(ctx.clone(), code)),
        }
    }
    set_fn(native, "hostFetchHead", |ctx: Ctx<'js>, h: i32| text_or_code(&ctx, host::fetch_head(h)))?;
    set_fn(native, "hostError", |ctx: Ctx<'js>, h: i32| text_or_code(&ctx, host::error(h)))?;
    set_fn(native, "hostPeerAddr", |ctx: Ctx<'js>, h: i32| text_or_code(&ctx, host::peer_addr(h)))?;
    set_fn(native, "hostRead", |ctx: Ctx<'js>, h: i32, cap: Opt<i32>| -> Result<Value<'js>> {
        let cap = cap.0.unwrap_or(65536).max(1) as usize;
        match host::read(h, cap) {
            Ok(bytes) if bytes.is_empty() => Ok(Value::new_int(ctx, 0)),
            Ok(bytes) => uint8(&ctx, bytes),
            Err(code) => Ok(Value::new_int(ctx, code)),
        }
    })?;
    set_fn(native, "hostWrite", |h: i32, data: Value<'js>| -> Result<i32> { Ok(host::write(h, &bytes_of(&data)?)) })?;
    set_fn(native, "hostClose", |h: i32| host::close(h))?;
    set_fn(native, "hostListen", |hostname: String, port: i32| host::listen(&hostname, port))?;
    set_fn(native, "hostLocalPort", |h: i32| host::local_port(h))?;
    set_fn(native, "hostAccept", |h: i32| host::accept(h))?;
    set_fn(native, "hostConnect", |hostname: String, port: i32| host::connect(&hostname, port))?;
    Ok(())
}

fn wasm_memory_bytes() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        (core::arch::wasm32::memory_size(0) * 65536) as f64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0.0
    }
}

fn platform_info<'js>(ctx: &Ctx<'js>) -> Result<Value<'js>> {
    let obj = Object::new(ctx.clone())?;
    obj.set("version", crate::BUN_VERSION)?;
    obj.set("revision", crate::BUN_REVISION)?;
    obj.set("arch", if cfg!(target_arch = "wasm32") { "wasm32" } else { std::env::consts::ARCH })?;
    obj.into_js(ctx)
}
