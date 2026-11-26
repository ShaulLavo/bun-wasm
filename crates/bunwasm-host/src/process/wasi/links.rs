//! Symbolic links in the guest's namespace.
//!
//! Wasmtime's preview1 filesystem (cap-std) answers EPERM when a symlink's target is
//! absolute (creating, reading or following it) and when a path climbs above the descriptor
//! it starts from. Linux allows all of these, and inside the guest an absolute target names a
//! guest path. Every path call still goes to Wasmtime first; only its EPERM is retried here.
//! The path is walked component by component in the guest namespace: an absolute target
//! restarts at guest `/`, and `..` stops there. The call is then repeated from the deepest
//! preopen that holds the result, on a relative path with no symlink left to follow. Every
//! lookup goes through cap-std directories opened on the preopens, so a link never reaches a
//! host path outside them. Links are stored on the host as the guest wrote them.
use std::collections::VecDeque;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;

use anyhow::Result;
use cap_std::fs::Dir;
use wasmtime::{Caller, Linker, Memory, Store, Val};

use super::{Delegated, Namespace, call_values, call_values_in, memory, original, span};
use crate::Host;

/// Positive WASI errnos, the preview1 return convention.
pub(super) const PERM: i32 = 63;
const BADF: i32 = 8;
const FAULT: i32 = 21;
const ILSEQ: i32 = 25;
const LOOP: i32 = 32;
const NAMETOOLONG: i32 = 37;
const NOENT: i32 = 44;
const NOTDIR: i32 = 54;

/// Linux's limit on symlinks followed in one lookup (MAXSYMLINKS).
const MAX_LINKS: usize = 40;

/// Scratch layout for a retried call: two path slots, then the call's output.
const SLOT: usize = 28 << 10;
const OUTPUT: usize = 2 * SLOT;

/// A path argument of a preview1 call: positions of its descriptor, pointer and length, and of
/// the lookup flags whose bit 0 follows a final symlink.
struct PathArg {
    fd: usize,
    ptr: usize,
    len: usize,
    flags: Option<usize>,
}

/// A preview1 path call: its path arguments and its output (position and size), if any.
pub(super) struct Op {
    name: &'static str,
    paths: &'static [PathArg],
    output: Option<(usize, usize)>,
}

const fn path(fd: usize, ptr: usize, len: usize, flags: Option<usize>) -> PathArg {
    PathArg {
        fd,
        ptr,
        len,
        flags,
    }
}

const RENAME: &str = "path_rename";
const RENAME_PATHS: &[PathArg] = &[path(0, 1, 2, None), path(3, 4, 5, None)];

pub(super) static OPEN: Op = Op {
    name: "path_open",
    paths: &[path(0, 2, 3, Some(1))],
    output: Some((8, 4)),
};

static OPS: [Op; 7] = [
    Op {
        name: "path_create_directory",
        paths: &[path(0, 1, 2, None)],
        output: None,
    },
    Op {
        name: "path_filestat_get",
        paths: &[path(0, 2, 3, Some(1))],
        output: Some((4, 64)),
    },
    Op {
        name: "path_filestat_set_times",
        paths: &[path(0, 2, 3, Some(1))],
        output: None,
    },
    Op {
        name: "path_link",
        paths: &[path(0, 2, 3, Some(1)), path(4, 5, 6, None)],
        output: None,
    },
    Op {
        name: "path_remove_directory",
        paths: &[path(0, 1, 2, None)],
        output: None,
    },
    Op {
        name: RENAME,
        paths: RENAME_PATHS,
        output: None,
    },
    Op {
        name: "path_unlink_file",
        paths: &[path(0, 1, 2, None)],
        output: None,
    },
];

/// The guest's preopens, as cap-std directories opened on first use.
pub(super) struct Roots {
    mounts: Vec<(PathBuf, String)>,
    dirs: Option<Vec<Option<Dir>>>,
}

/// A path resolved in the guest namespace: the preopen holding it, the path inside that
/// preopen, and the absolute guest path.
pub(super) struct Resolved {
    pub root: usize,
    pub relative: String,
    pub guest: String,
    opaque_link: bool,
}

enum Kind {
    Missing,
    Directory,
    Other,
    Link(String),
    /// A symlink whose host target is not valid UTF-8.
    OpaqueLink,
    /// A lookup failure other than a missing entry (EACCES and the like), as a WASI errno.
    Failed(i32),
}

impl Roots {
    pub fn new(mounts: Vec<(PathBuf, String)>) -> Self {
        Self { mounts, dirs: None }
    }

    pub fn len(&self) -> usize {
        self.mounts.len()
    }

    fn dir(&mut self, index: usize) -> Option<&Dir> {
        let mounts = &self.mounts;
        let dirs = self.dirs.get_or_insert_with(|| {
            mounts
                .iter()
                .map(|(host, _)| Dir::open_ambient_dir(host, cap_std::ambient_authority()).ok())
                .collect()
        });
        dirs.get(index)?.as_ref()
    }

    /// The deepest preopen holding an absolute, normalized guest path, and the rest of it.
    fn mount<'a>(&self, path: &'a str) -> Option<(usize, &'a str)> {
        self.mounts
            .iter()
            .enumerate()
            .filter(|(_, (_, guest))| guest.starts_with('/'))
            .filter_map(|(index, (_, guest))| {
                let guest = guest.trim_end_matches('/');
                let rest = path.strip_prefix(guest)?;
                let rest = if rest.is_empty() {
                    rest
                } else {
                    rest.strip_prefix('/')?
                };
                Some((guest.len(), index, rest))
            })
            .max_by_key(|(length, ..)| *length)
            .map(|(_, index, rest)| (index, rest))
    }

    fn kind(&mut self, path: &str) -> Kind {
        self.kind_in(path, None)
    }

    fn kind_in(&mut self, path: &str, live: Option<&[bool]>) -> Kind {
        // A nested preopen makes its ancestors directories in the guest namespace.
        let ancestor = self.mounts.iter().enumerate().any(|(index, (_, guest))| {
            live.is_none_or(|live| live.get(index).copied().unwrap_or(false))
                && guest.len() > path.len()
                && guest.starts_with(path)
                && guest.as_bytes()[path.len()] == b'/'
        });
        if ancestor {
            return Kind::Directory;
        }
        let Some((index, rest)) = self.mount(path) else {
            return Kind::Missing;
        };
        if live.is_some_and(|live| !live.get(index).copied().unwrap_or(false)) {
            return Kind::Missing;
        }
        if rest.is_empty() {
            return Kind::Directory;
        }
        let rest = rest.to_owned();
        let Some(dir) = self.dir(index) else {
            return Kind::Missing;
        };
        let metadata = match dir.symlink_metadata(&rest) {
            Ok(metadata) => metadata,
            Err(error) if matches!(wasi_errno(&error), NOENT | NOTDIR) => return Kind::Missing,
            Err(error) => return Kind::Failed(wasi_errno(&error)),
        };
        if metadata.is_dir() {
            return Kind::Directory;
        }
        if !metadata.is_symlink() {
            return Kind::Other;
        }
        match dir.read_link_contents(&rest).map(PathBuf::into_os_string) {
            Ok(target) => target.into_string().map_or(Kind::OpaqueLink, Kind::Link),
            Err(_) => Kind::Missing,
        }
    }

    /// Resolve `path` from the directory at guest path `start` as Linux would inside the guest
    /// namespace. Every component but the last must be a directory after following links; the
    /// last is followed when `follow` is set or the path ends in `/`.
    pub fn resolve(&mut self, start: &str, path: &str, follow: bool) -> Result<Resolved, i32> {
        self.walk(start, path, follow, false)
    }

    /// [`Self::resolve`]; with `directories`, a path or link target ending in `/` or `/.` (or
    /// being `.`) makes the component before it a directory, as realpath(3) requires: a file
    /// there is ENOTDIR. A [`DIRECTORY`] mark stands for that requirement while walking.
    fn walk(
        &mut self,
        start: &str,
        path: &str,
        follow: bool,
        directories: bool,
    ) -> Result<Resolved, i32> {
        self.walk_in(start, path, follow, directories, None, false)
    }

    fn walk_in(
        &mut self,
        start: &str,
        path: &str,
        follow: bool,
        directories: bool,
        live: Option<&[bool]>,
        allow_opaque_link: bool,
    ) -> Result<Resolved, i32> {
        let follow = follow || path.ends_with('/');
        let mut pending: VecDeque<String> = VecDeque::new();
        if !path.starts_with('/') {
            pending.extend(parts(start));
        }
        pending.extend(parts(path));
        if directories && names_directory(path) {
            pending.push_back(DIRECTORY.to_owned());
        }
        // The resolved path so far, as `/a/b`; empty is the guest root.
        let mut current = String::new();
        let mut links = 0;
        while let Some(part) = pending.pop_front() {
            // The component before a mark is no longer last, so it must be a directory.
            if part == DIRECTORY {
                continue;
            }
            if part == ".." {
                current.truncate(current.rfind('/').unwrap_or(0));
                continue;
            }
            let parent = current.len();
            current.push('/');
            current.push_str(&part);
            let last = pending.is_empty();
            if last && !follow {
                break;
            }
            match self.kind_in(&current, live) {
                Kind::Link(target) => {
                    links += 1;
                    if links > MAX_LINKS {
                        return Err(LOOP);
                    }
                    current.truncate(if target.starts_with('/') { 0 } else { parent });
                    if directories && names_directory(&target) {
                        pending.push_front(DIRECTORY.to_owned());
                    }
                    for part in parts(&target).rev() {
                        pending.push_front(part);
                    }
                }
                Kind::OpaqueLink if allow_opaque_link => {
                    let (root, rest) = self.mount(&current).ok_or(NOENT)?;
                    if live.is_some_and(|live| !live.get(root).copied().unwrap_or(false)) {
                        return Err(PERM);
                    }
                    let mut relative = if rest.is_empty() {
                        ".".to_owned()
                    } else {
                        rest.to_owned()
                    };
                    for tail in pending {
                        relative.push('/');
                        relative.push_str(&tail);
                    }
                    return Ok(Resolved {
                        root,
                        relative,
                        guest: current,
                        opaque_link: true,
                    });
                }
                Kind::Missing if !last => return Err(NOENT),
                Kind::Other | Kind::OpaqueLink if !last => return Err(NOTDIR),
                Kind::Failed(errno) if !last => return Err(errno),
                _ => {}
            }
        }
        let guest = if current.is_empty() {
            "/".to_owned()
        } else {
            current
        };
        let (root, rest) = self.mount(&guest).ok_or(NOENT)?;
        if live.is_some_and(|live| !live.get(root).copied().unwrap_or(false)) {
            return Err(PERM);
        }
        let mut relative = if rest.is_empty() {
            ".".to_owned()
        } else {
            rest.to_owned()
        };
        if path.ends_with('/') && relative != "." {
            relative.push('/');
        }
        Ok(Resolved {
            root,
            relative,
            guest,
            opaque_link: false,
        })
    }
}

impl Roots {
    /// Whether `path` from the directory at guest path `start`, every link followed, names a
    /// directory (`directory`) or a regular file, as a stat with the follow flag would answer
    /// (`runtime_fs.path_probe`). A path that does not resolve names neither.
    #[cfg(test)]
    pub fn names(&mut self, start: &str, path: &str, directory: bool) -> bool {
        let live = vec![true; self.mounts.len()];
        self.names_in(start, path, directory, &live)
    }

    /// [`Self::names`], restricting lookups to preopens whose `live` slot is still open.
    pub fn names_in(&mut self, start: &str, path: &str, directory: bool, live: &[bool]) -> bool {
        if path.is_empty() || path.starts_with('/') {
            return false;
        }
        let Ok(resolved) = self.walk_in(start, path, true, true, Some(live), true) else {
            return false;
        };
        if !live.get(resolved.root).copied().unwrap_or(false) {
            return false;
        }
        if directory && !resolved.opaque_link {
            return matches!(self.kind_in(&resolved.guest, Some(live)), Kind::Directory);
        }
        let Some(dir) = self.dir(resolved.root) else {
            return false;
        };
        dir.metadata(&resolved.relative).is_ok_and(|metadata| {
            if directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            }
        })
    }

    /// `realpath(3)` of `path` from the directory at guest path `start`: the absolute guest
    /// path with every link followed, which must exist (`runtime_fs.path_realpath`).
    pub fn realpath(&mut self, start: &str, path: &str) -> Result<String, i32> {
        if path.starts_with('/') {
            return Err(PERM);
        }
        if !matches!(self.kind(&normalize(start)), Kind::Directory) {
            return Err(NOTDIR);
        }
        let resolved = self.walk(start, path, true, true)?;
        match self.kind(&resolved.guest) {
            Kind::Missing => Err(NOENT),
            Kind::Failed(errno) => Err(errno),
            _ => Ok(resolved.guest),
        }
    }
}

/// A walk mark: never a component, since [`parts`] drops every `.`.
const DIRECTORY: &str = ".";

/// Whether `path` must name a directory: it ends in `/` or `/.`, or is `.`.
fn names_directory(path: &str) -> bool {
    path.ends_with('/') || path == "." || path.ends_with("/.")
}
/// The non-empty components of a path other than `.`.
fn parts(path: &str) -> impl DoubleEndedIterator<Item = String> + '_ {
    path.split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .map(str::to_owned)
}

/// The guest path of `path` opened from the directory at guest path `base`, unresolved: links
/// and `..` in it are resolved again when a retried call starts from it.
pub(super) fn join(base: &str, path: &str) -> String {
    if path.starts_with('/') {
        return path.to_owned();
    }
    let mut joined = base.trim_end_matches('/').to_owned();
    for part in parts(path) {
        joined.push('/');
        joined.push_str(&part);
    }
    if joined.is_empty() {
        joined.push('/');
    }
    joined
}

/// A native filesystem failure in WASI's positive errno domain.
pub(crate) fn wasi_errno(error: &io::Error) -> i32 {
    let Some(code) = error.raw_os_error() else {
        // cap-std reports a sandbox escape as PermissionDenied without an OS error.
        return if error.kind() == io::ErrorKind::PermissionDenied {
            PERM
        } else {
            29
        };
    };
    match code {
        libc::EACCES => 2,
        libc::EBADF => BADF,
        libc::EBUSY => 10,
        libc::EDQUOT => 19,
        libc::EEXIST => 20,
        libc::EFBIG => 22,
        libc::EILSEQ => ILSEQ,
        libc::EINTR => 27,
        libc::EINVAL => 28,
        libc::EISDIR => 31,
        libc::ELOOP => LOOP,
        libc::EMFILE => 33,
        libc::EMLINK => 34,
        libc::ENAMETOOLONG => NAMETOOLONG,
        libc::ENFILE => 41,
        libc::ENOENT => NOENT,
        libc::ENOMEM => 48,
        libc::ENOSPC => 51,
        libc::ENOTDIR => NOTDIR,
        libc::ENOTEMPTY => 55,
        libc::ENOTSUP => 58,
        libc::EOVERFLOW => 61,
        libc::EPERM => PERM,
        libc::EROFS => 69,
        libc::ETXTBSY => 74,
        libc::EXDEV => 75,
        _ => 29,
    }
}

/// A guest string argument, or the errno for a bad span or bytes that are not UTF-8.
pub(super) fn read_path(
    caller: &mut Caller<'_, Host>,
    ptr: i32,
    len: i32,
) -> Result<Result<String, i32>> {
    let memory = memory(caller)?;
    let Some(range) = span(memory.len(&*caller), ptr, len as u32 as usize) else {
        return Ok(Err(FAULT));
    };
    let bytes = memory.read(&*caller, range).unwrap_or_default();
    Ok(String::from_utf8(bytes).map_err(|_| ILSEQ))
}

/// Resolve the path argument at `ptr`/`len`, read from the guest, starting at descriptor `fd`.
fn resolve_arg(
    namespace: &mut Namespace,
    caller: &mut Caller<'_, Host>,
    fd: i32,
    (ptr, len): (i32, i32),
    follow: bool,
) -> Result<Result<Resolved, i32>> {
    let Some(start) = namespace.paths.get(&fd).cloned() else {
        return Ok(Err(PERM));
    };
    let path = match read_path(caller, ptr, len)? {
        Ok(path) => path,
        Err(errno) => return Ok(Err(errno)),
    };
    Ok(namespace.roots.resolve(&start, &path, follow))
}

/// Repeat a call Wasmtime refused with EPERM, its paths resolved in the guest namespace and
/// written to private scratch memory. Returns the errno and, on success, the guest form of
/// each path argument.
pub(super) fn retry(
    namespace: &mut Namespace,
    caller: &mut Caller<'_, Host>,
    delegate: &Delegated,
    scratch: Memory,
    op: &Op,
    args: &[Val],
) -> Result<(i32, Vec<String>)> {
    let mut call = args.to_vec();
    let mut guests = Vec::new();
    for (slot, arg) in op.paths.iter().enumerate() {
        let follow = arg.flags.is_some_and(|at| args[at].unwrap_i32() & 1 != 0);
        let location = (args[arg.ptr].unwrap_i32(), args[arg.len].unwrap_i32());
        let fd = args[arg.fd].unwrap_i32();
        let resolved = match resolve_arg(namespace, caller, fd, location, follow)? {
            Ok(resolved) => resolved,
            Err(errno) => return Ok((errno, Vec::new())),
        };
        let Some(actual) = namespace.root_fd(resolved.root) else {
            return Ok((PERM, Vec::new()));
        };
        if resolved.relative.len() > SLOT {
            return Ok((NAMETOOLONG, Vec::new()));
        }
        scratch.write(&mut *caller, slot * SLOT, resolved.relative.as_bytes())?;
        call[arg.fd] = Val::I32(actual);
        call[arg.ptr] = Val::I32((slot * SLOT) as i32);
        call[arg.len] = Val::I32(resolved.relative.len() as i32);
        guests.push(resolved.guest);
    }
    let memory = memory(caller)?;
    let output = match op.output {
        Some((at, size)) => {
            let Some(range) = span(memory.len(&*caller), args[at].unwrap_i32(), size) else {
                return Ok((FAULT, Vec::new()));
            };
            call[at] = Val::I32(OUTPUT as i32);
            Some(range)
        }
        None => None,
    };
    let result = call_values_in(delegate, caller, &call, Some(scratch))?;
    if result != 0 {
        return Ok((result, Vec::new()));
    }
    if let Some(range) = output {
        let bytes = scratch.data(&*caller)[OUTPUT..OUTPUT + range.len()].to_vec();
        memory
            .write(&mut *caller, range.start, &bytes)
            .ok_or_else(|| anyhow::anyhow!("validated call output"))?;
    }
    Ok((0, guests))
}

/// A path with `.` and `..` folded lexically, for comparing recorded descriptor paths.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => drop(parts.pop()),
            part => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

/// After a successful rename, descriptors open on or under the old guest path record the new
/// one, as Linux keeps them on the moved directory.
fn record_rename(
    namespace: &mut Namespace,
    caller: &mut Caller<'_, Host>,
    args: &[Val],
    mut guests: Vec<String>,
) -> Result<()> {
    if guests.len() != 2 {
        guests.clear();
        for arg in RENAME_PATHS {
            let Some(base) = namespace.paths.get(&args[arg.fd].unwrap_i32()).cloned() else {
                return Ok(());
            };
            let Ok(path) = read_path(
                caller,
                args[arg.ptr].unwrap_i32(),
                args[arg.len].unwrap_i32(),
            )?
            else {
                return Ok(());
            };
            guests.push(join(&base, &path));
        }
    }
    let (from, to) = (normalize(&guests[0]), normalize(&guests[1]));
    for path in namespace.paths.values_mut() {
        let current = normalize(path);
        let Some(rest) = current.strip_prefix(&from) else {
            continue;
        };
        if rest.is_empty() || rest.starts_with('/') {
            *path = format!("{to}{rest}");
        }
    }
    Ok(())
}

/// One wrapped path call: Wasmtime first, then a guest-namespace retry of its EPERM.
#[allow(clippy::too_many_arguments)]
fn path_call(
    namespace: &mut Namespace,
    caller: &mut Caller<'_, Host>,
    delegate: &Delegated,
    again: &Delegated,
    scratch: Memory,
    op: &Op,
    positions: &[usize],
    args: &[Val],
) -> Result<i32> {
    let mut args = args.to_vec();
    follow_trailing_slash(caller, op, &mut args)?;
    let call = match translate(namespace, &args, positions) {
        Ok(call) => call,
        Err(errno) => return Ok(errno),
    };
    let mut result = call_values(delegate, caller, &call)?;
    let mut guests = Vec::new();
    if result == PERM {
        (result, guests) = retry(namespace, caller, again, scratch, op, &args)?;
    }
    if result == 0 && op.name == RENAME {
        record_rename(namespace, caller, &args, guests)?;
    }
    Ok(result)
}

/// A trailing `/` names a directory, so Linux follows a final link there even for `lstat` and
/// `O_NOFOLLOW`; cap-std reports the link itself. Set the follow flag for such paths.
pub(super) fn follow_trailing_slash(
    caller: &mut Caller<'_, Host>,
    op: &Op,
    args: &mut [Val],
) -> Result<()> {
    let memory = memory(caller)?;
    for arg in op.paths {
        let Some(flags) = arg.flags else {
            continue;
        };
        let (ptr, len) = (args[arg.ptr].unwrap_i32(), args[arg.len].unwrap_i32());
        let size = memory.len(&*caller);
        let Some(last) = (len > 0)
            .then(|| span(size, ptr.wrapping_add(len - 1), 1))
            .flatten()
        else {
            continue;
        };
        if memory.read(&*caller, last).as_deref() == Some(b"/") {
            args[flags] = Val::I32(args[flags].unwrap_i32() | 1);
        }
    }
    Ok(())
}

/// A delegate over the same preview1 function, bound to private scratch memory on first use.
pub(super) fn rebind(delegate: &Delegated) -> Delegated {
    Delegated {
        original: delegate.original,
        module: delegate.module.clone(),
        shared: delegate.shared.clone(),
        cached: std::sync::Mutex::new(None),
    }
}

/// Translate descriptor positions to Wasmtime's, or return EBADF.
fn translate(namespace: &Namespace, args: &[Val], positions: &[usize]) -> Result<Vec<Val>, i32> {
    let mut call = args.to_vec();
    for &at in positions {
        let &actual = namespace.files.get(&args[at].unwrap_i32()).ok_or(BADF)?;
        call[at] = Val::I32(actual);
    }
    Ok(call)
}

/// The path calls: Wasmtime first, then a guest-namespace retry of its EPERM.
pub(super) fn install(
    linker: &mut Linker<Host>,
    store: &mut Store<Host>,
    namespace: &std::sync::Arc<std::sync::Mutex<Namespace>>,
    scratch: Memory,
) -> Result<()> {
    for op in OPS.iter() {
        let delegate = original(linker, store, op.name)?;
        let again = rebind(&delegate);
        let ty = delegate.original.ty(&*store);
        let state = namespace.clone();
        let positions: Vec<usize> = op.paths.iter().map(|arg| arg.fd).collect();
        linker.func_new(
            "wasi_snapshot_preview1",
            op.name,
            ty,
            move |mut caller, args, results| {
                let mut state = state.lock().unwrap();
                state.initialize(&mut caller)?;
                let result = path_call(
                    &mut state,
                    &mut caller,
                    &delegate,
                    &again,
                    scratch,
                    op,
                    &positions,
                    args,
                )?;
                results[0] = Val::I32(result);
                Ok(())
            },
        )?;
    }
    install_readlink(linker, store, namespace)?;
    install_probe(linker, namespace)?;
    install_realpath(linker, namespace)?;
    install_symlink(linker, store, namespace)
}

/// Most pathnames one `runtime_fs.path_probe` call takes, as in Waffle.
const PROBE_LIMIT: usize = 64;

/// A `path_probe` list: one to [`PROBE_LIMIT`] UTF-8 pathnames, each ended by a NUL.
/// Enforces [`PROBE_LIMIT`] while scanning so oversized lists stop before allocating.
fn probe_names(bytes: &[u8]) -> Option<Vec<&str>> {
    let (last, body) = bytes.split_last()?;
    if *last != 0 {
        return None;
    }
    let mut names = Vec::new();
    let mut start = 0;
    for (i, &byte) in body.iter().enumerate() {
        if byte == 0 {
            if names.len() + 1 >= PROBE_LIMIT {
                return None;
            }
            names.push(std::str::from_utf8(&body[start..i]).ok()?);
            start = i + 1;
        }
    }
    names.push(std::str::from_utf8(&body[start..]).ok()?);
    Some(names)
}

/// Waffle's `runtime_fs.path_probe`: the index of the first pathname that names a regular file
/// (`kind` 1) or a directory (`kind` 2), or `0xffffffff`, at `found` (Waffle docs/host-abi.md).
fn install_probe(
    linker: &mut Linker<Host>,
    namespace: &std::sync::Arc<std::sync::Mutex<Namespace>>,
) -> Result<()> {
    const INVAL: i32 = 28;
    let state = namespace.clone();
    linker.func_wrap(
        "runtime_fs",
        "path_probe",
        move |mut caller: Caller<'_, Host>,
              fd: i32,
              paths: i32,
              length: i32,
              kind: i32,
              found: i32|
              -> Result<i32> {
            let memory = memory(&mut caller)?;
            let size = memory.len(&caller);
            let (Some(list), Some(output)) = (
                span(size, paths, length as u32 as usize),
                span(size, found, 4),
            ) else {
                return Ok(FAULT);
            };
            let Some(names) = memory
                .view(&mut caller, &[list], |views, _| {
                    probe_names(views[0])
                        .map(|names| names.into_iter().map(str::to_owned).collect::<Vec<_>>())
                })
                .flatten()
            else {
                return Ok(INVAL);
            };
            let directory = match kind {
                1 => false,
                2 => true,
                _ => return Ok(INVAL),
            };
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            let start = state.paths.get(&fd).cloned();
            let Some(start) = start.filter(|_| state.files.contains_key(&fd)) else {
                return Ok(BADF);
            };
            let live: Vec<bool> = (0..state.roots.len())
                .map(|index| state.root_fd(index).is_some())
                .collect();
            if !matches!(
                state.roots.kind_in(&normalize(&start), Some(&live)),
                Kind::Directory
            ) {
                return Ok(NOTDIR);
            }
            let index = names
                .iter()
                .position(|name| state.roots.names_in(&start, name, directory, &live));
            drop(state);
            let word = index.map_or(u32::MAX, |index| index as u32);
            super::store_word(&memory, &mut caller, output.start, word)?;
            Ok(0)
        },
    )?;
    Ok(())
}

/// Waffle's `runtime_fs.path_realpath`: the canonical guest path in one call, with the
/// result's length at `used` and ENOBUFS when it does not fit (Waffle docs/host-abi.md).
fn install_realpath(
    linker: &mut Linker<Host>,
    namespace: &std::sync::Arc<std::sync::Mutex<Namespace>>,
) -> Result<()> {
    const INVAL: i32 = 28;
    const NOBUFS: i32 = 42;
    let state = namespace.clone();
    linker.func_wrap(
        "runtime_fs",
        "path_realpath",
        move |mut caller: Caller<'_, Host>,
              fd: i32,
              path: i32,
              length: i32,
              buf: i32,
              capacity: i32,
              used: i32|
              -> Result<i32> {
            let memory = memory(&mut caller)?;
            let size = memory.len(&caller);
            let (Some(buffer), Some(output)) = (
                span(size, buf, capacity as u32 as usize),
                span(size, used, 4),
            ) else {
                return Ok(FAULT);
            };
            // Either result would clobber the other.
            if !buffer.is_empty() && buffer.start < output.end && output.start < buffer.end {
                return Ok(INVAL);
            }
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            // The pathname is its exact bytes: malformed UTF-8 or a NUL is EINVAL, as in Waffle.
            let path = match read_path(&mut caller, path, length)? {
                Ok(path) if !path.contains('\0') => path,
                Ok(_) | Err(ILSEQ) => return Ok(INVAL),
                Err(errno) => return Ok(errno),
            };
            let start = state.paths.get(&fd).cloned();
            let Some(start) = start.filter(|_| state.files.contains_key(&fd)) else {
                return Ok(BADF);
            };
            let real = match state.roots.realpath(&start, &path) {
                Ok(real) => real,
                Err(errno) => return Ok(errno),
            };
            drop(state);
            super::store_word(&memory, &mut caller, output.start, real.len() as u32)?;
            if real.len() > buffer.len() {
                return Ok(NOBUFS);
            }
            memory
                .write(&mut caller, buffer.start, real.as_bytes())
                .ok_or_else(|| anyhow::anyhow!("validated realpath buffer"))?;
            Ok(0)
        },
    )?;
    Ok(())
}

fn install_readlink(
    linker: &mut Linker<Host>,
    store: &mut Store<Host>,
    namespace: &std::sync::Arc<std::sync::Mutex<Namespace>>,
) -> Result<()> {
    let delegate = original(linker, store, "path_readlink")?;
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "path_readlink",
        move |mut caller: Caller<'_, Host>,
              fd: i32,
              path: i32,
              length: i32,
              buf: i32,
              capacity: i32,
              out: i32|
              -> Result<i32> {
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            let Some(&actual) = state.files.get(&fd) else {
                return Ok(BADF);
            };
            let args = [actual, path, length, buf, capacity, out].map(Val::I32);
            let result = call_values(&delegate, &mut caller, &args)?;
            if result != PERM {
                return Ok(result);
            }
            // cap-std reads no absolute target: read it here, as written.
            let memory = memory(&mut caller)?;
            let size = memory.len(&caller);
            let (Some(buffer), Some(output)) = (
                span(size, buf, capacity as u32 as usize),
                span(size, out, 4),
            ) else {
                return Ok(FAULT);
            };
            let resolved = match resolve_arg(&mut state, &mut caller, fd, (path, length), false)? {
                Ok(resolved) => resolved,
                Err(errno) => return Ok(errno),
            };
            let Some(dir) = state.roots.dir(resolved.root) else {
                return Ok(PERM);
            };
            let mut target = match dir.read_link_contents(&resolved.relative) {
                Ok(target) => target.into_os_string().into_vec(),
                Err(error) => return Ok(wasi_errno(&error)),
            };
            target.truncate(buffer.len());
            drop(state);
            memory
                .write(&mut caller, buffer.start, &target)
                .ok_or_else(|| anyhow::anyhow!("validated readlink buffer"))?;
            super::store_word(&memory, &mut caller, output.start, target.len() as u32)?;
            Ok(0)
        },
    )?;
    Ok(())
}

fn install_symlink(
    linker: &mut Linker<Host>,
    store: &mut Store<Host>,
    namespace: &std::sync::Arc<std::sync::Mutex<Namespace>>,
) -> Result<()> {
    let delegate = original(linker, store, "path_symlink")?;
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "path_symlink",
        move |mut caller: Caller<'_, Host>,
              target: i32,
              target_length: i32,
              fd: i32,
              path: i32,
              length: i32|
              -> Result<i32> {
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            let Some(&actual) = state.files.get(&fd) else {
                return Ok(BADF);
            };
            let args = [target, target_length, actual, path, length].map(Val::I32);
            let result = call_values(&delegate, &mut caller, &args)?;
            if result != PERM {
                return Ok(result);
            }
            // cap-std creates no absolute target: store it as written, under the link's
            // parent resolved in the guest namespace.
            let target = match read_path(&mut caller, target, target_length)? {
                Ok(target) => target,
                Err(errno) => return Ok(errno),
            };
            let resolved = match resolve_arg(&mut state, &mut caller, fd, (path, length), false)? {
                Ok(resolved) => resolved,
                Err(errno) => return Ok(errno),
            };
            let Some(dir) = state.roots.dir(resolved.root) else {
                return Ok(PERM);
            };
            Ok(match dir.symlink_contents(&target, &resolved.relative) {
                Ok(()) => 0,
                Err(error) => wasi_errno(&error),
            })
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host directory mounted at guest `/` and one mounted at `/mnt`, removed on drop.
    struct Mounts(PathBuf);

    impl Mounts {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!("bunwasm-links-{nanos}"));
            for dir in [
                "root/real/dir",
                "root/real/pkg",
                "root/home/user/node_modules",
                "root/app/node_modules/vue",
                "mnt/data",
            ] {
                std::fs::create_dir_all(root.join(dir)).unwrap();
            }
            std::fs::write(root.join("root/real/dir/file.txt"), "x").unwrap();
            std::fs::write(root.join("root/real/pkg/index.js"), "x").unwrap();
            let link = |target: &str, at: &str| {
                std::os::unix::fs::symlink(target, root.join(at)).unwrap();
            };
            link("../../../real/dir", "root/home/user/node_modules/pkg");
            link("/real/dir", "root/home/user/abs");
            link("/mnt/data", "root/home/user/mounted");
            link("self", "root/home/user/self");
            link("missing", "root/home/user/dangling");
            link("/real/dir/file.txt/", "root/home/user/slashed");
            link("/real/pkg", "root/app/node_modules/abs");
            link("../../real/pkg", "root/app/node_modules/rel");
            link("missing", "root/app/node_modules/dangling");
            link("loop", "root/app/loop");
            Self(root)
        }

        fn roots(&self) -> Roots {
            Roots::new(vec![
                (self.0.join("root"), "/".to_owned()),
                (self.0.join("mnt"), "/mnt".to_owned()),
            ])
        }
    }

    impl Drop for Mounts {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn names_answers_as_a_following_stat() {
        let mounts = Mounts::new();
        let mut roots = mounts.roots();
        let cases = [
            ("/", "app/node_modules/vue", true, true),
            ("/", "app/node_modules/vue", false, false),
            ("/", "real/pkg/index.js", false, true),
            ("/", "real/pkg/index.js", true, false),
            ("/", "app/node_modules/abs/index.js", false, true),
            ("/", "app/node_modules/rel", true, true),
            ("/app", "../real/pkg/index.js", false, true),
            ("/", "app/node_modules/dangling", true, false),
            ("/", "app/loop", false, false),
            ("/", "real/pkg/index.js/", false, false),
            ("/", "real/pkg/index.js/.", false, false),
            ("/", "real/pkg/index.js/x", false, false),
            ("/home/user", "slashed", false, false),
            ("/", "app/missing/x", true, false),
            ("/", "/real/pkg", true, false),
            ("/", "", true, false),
            ("/", ".", true, true),
        ];
        for (start, path, directory, expected) in cases {
            assert_eq!(
                roots.names(start, path, directory),
                expected,
                "{start} {path} {directory}"
            );
        }
    }

    #[test]
    fn probe_lists_end_in_a_nul_and_hold_at_most_the_limit() {
        assert_eq!(probe_names(b"a\0b/c\0"), Some(vec!["a", "b/c"]));
        assert_eq!(probe_names(b"\0"), Some(vec![""]));
        assert_eq!(probe_names(b""), None);
        assert_eq!(probe_names(b"a"), None);
        assert_eq!(probe_names(b"\xff\0"), None);
        assert!(probe_names(&b"a\0".repeat(PROBE_LIMIT)).is_some());
        assert_eq!(probe_names(&b"a\0".repeat(PROBE_LIMIT + 1)), None);
        assert_eq!(probe_names(&b"a\0".repeat(100_000)), None);
    }

    #[test]
    fn names_in_ignores_closed_preopens() {
        let mounts = Mounts::new();
        let mut roots = mounts.roots();
        assert!(roots.names_in("/", "mnt/data", true, &[true, true]));
        assert!(roots.names_in("/home/user", "mounted", true, &[true, true]));
        // Closing `/mnt` prevents probes from consulting that mount directly or via symlink.
        assert!(!roots.names_in("/", "mnt/data", true, &[true, false]));
        assert!(!roots.names_in("/", "mnt", true, &[true, false]));
        assert!(!roots.names_in("/home/user", "mounted", true, &[true, false]));
        // The still-open `/` preopen continues to resolve normally.
        assert!(roots.names_in("/", "real/pkg/index.js", false, &[true, false]));
    }

    #[test]
    fn names_follows_relative_symlink_to_non_utf8_directory() {
        let mounts = Mounts::new();
        let raw_dir = std::ffi::OsString::from_vec(b"nonutf8-\xff".to_vec());
        let target_dir = mounts.0.join("root/real").join(&raw_dir);
        std::fs::create_dir_all(&target_dir).unwrap();
        std::fs::write(target_dir.join("index.js"), "x").unwrap();
        let mut rel_target = std::ffi::OsString::from("../../real/");
        rel_target.push(&raw_dir);
        std::os::unix::fs::symlink(&rel_target, mounts.0.join("root/app/node_modules/nonutf8"))
            .unwrap();
        let mut roots = mounts.roots();
        assert!(roots.names("/", "app/node_modules/nonutf8", true));
        assert!(!roots.names("/", "app/node_modules/nonutf8", false));
        assert!(roots.names("/", "app/node_modules/nonutf8/index.js", false));
        assert!(!roots.names("/", "app/node_modules/nonutf8/index.js/", false));
    }

    #[test]
    fn realpath_follows_every_link_in_the_guest_namespace() {
        let mounts = Mounts::new();
        let mut roots = mounts.roots();
        let real = |roots: &mut Roots, start: &str, path: &str| roots.realpath(start, path);
        let cases = [
            (
                "/",
                "home/user/node_modules/pkg/file.txt",
                Ok("/real/dir/file.txt"),
            ),
            ("/", "home/user/abs/", Ok("/real/dir")),
            (
                "/home/user",
                "abs/../dir/file.txt",
                Ok("/real/dir/file.txt"),
            ),
            ("/home/user", "mounted", Ok("/mnt/data")),
            ("/home/user", "../..", Ok("/")),
            ("/", ".", Ok("/")),
            ("/", "home/user/missing", Err(NOENT)),
            ("/", "home/user/dangling", Err(NOENT)),
            ("/", "real/dir/file.txt/", Err(NOTDIR)),
            ("/", "real/dir/file.txt/x", Err(NOTDIR)),
            ("/", "real/dir/file.txt/.", Err(NOTDIR)),
            ("/home/user", "slashed", Err(NOTDIR)),
            ("/", "real/dir/.", Ok("/real/dir")),
            ("/home/user", "abs/.", Ok("/real/dir")),
            ("/", "home/user/self", Err(LOOP)),
            ("/", "/real", Err(PERM)),
            ("/real/dir/file.txt", "x", Err(NOTDIR)),
        ];
        for (start, path, expected) in cases {
            let expected = expected.map(str::to_owned);
            assert_eq!(real(&mut roots, start, path), expected, "{start} {path}");
        }
    }
}
