//! fd → path, the `/proc/self/fd/N` readlink that WASI has no equivalent of.
//!
//! `bun_sys` reports every `openat` it makes and every `close`
//! (`bunwasm_fd_opened` / `bunwasm_fd_closed`); `bun_sys::get_fd_path` asks
//! `bunwasm_fd_path`. Paths are absolute and normalized, but symlinks are not
//! resolved (WASI hosts rarely expose them). Preopened directories answer with
//! their preopen name.
use core::ffi::{c_char, c_int};
use std::cell::RefCell;
use std::collections::HashMap;

std::thread_local! {
    static PATHS: RefCell<HashMap<c_int, Vec<u8>>> = RefCell::new(HashMap::new());
}

/// Joins `rel` onto `base` (absolute), resolving `.` and `..`.
fn join(base: &[u8], rel: &[u8]) -> Vec<u8> {
    let mut parts: Vec<&[u8]> = Vec::new();
    let start: &[u8] = if rel.first() == Some(&b'/') { b"" } else { base };
    for part in start.split(|&c| c == b'/').chain(rel.split(|&c| c == b'/')) {
        match part {
            b"" | b"." => {}
            b".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    let mut out = Vec::with_capacity(base.len() + rel.len() + 1);
    for p in &parts {
        out.push(b'/');
        out.extend_from_slice(p);
    }
    if out.is_empty() {
        out.push(b'/');
    }
    out
}

fn cwd() -> Option<Vec<u8>> {
    let mut buf = vec![0u8; 4096];
    // SAFETY: `buf` is writable for its length.
    let p = unsafe { libc::getcwd(buf.as_mut_ptr().cast(), buf.len()) };
    if p.is_null() {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0)?;
    buf.truncate(len);
    Some(buf)
}

#[repr(C)]
struct Prestat {
    tag: u8,
    name_len: u32,
}

#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_prestat_get(fd: c_int, buf: *mut Prestat) -> u16;
    fn fd_prestat_dir_name(fd: c_int, path: *mut u8, len: usize) -> u16;
}

fn preopen_name(fd: c_int) -> Option<Vec<u8>> {
    let mut stat = Prestat { tag: 0, name_len: 0 };
    // SAFETY: `stat` is a valid out-parameter.
    if unsafe { fd_prestat_get(fd, &mut stat) } != 0 || stat.tag != 0 {
        return None;
    }
    let mut name = vec![0u8; stat.name_len as usize];
    // SAFETY: `name` is writable for `name_len` bytes.
    if unsafe { fd_prestat_dir_name(fd, name.as_mut_ptr(), name.len()) } != 0 {
        return None;
    }
    while name.last() == Some(&0) {
        name.pop();
    }
    Some(join(b"/", &name))
}

fn path_of(fd: c_int) -> Option<Vec<u8>> {
    if fd == libc::AT_FDCWD {
        return cwd();
    }
    PATHS.with_borrow(|m| m.get(&fd).cloned()).or_else(|| preopen_name(fd))
}

/// `fd` was opened at `path`, relative to `dirfd` (or `AT_FDCWD`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunwasm_fd_opened(dirfd: c_int, path: *const c_char, fd: c_int) {
    if fd < 0 || path.is_null() {
        return;
    }
    // SAFETY: the caller passes a NUL-terminated path.
    let rel = unsafe { core::ffi::CStr::from_ptr(path) }.to_bytes();
    let abs = if rel.first() == Some(&b'/') {
        Some(join(b"/", rel))
    } else {
        path_of(dirfd).map(|base| join(&base, rel))
    };
    PATHS.with_borrow_mut(|m| match abs {
        Some(abs) => {
            m.insert(fd, abs);
        }
        None => {
            m.remove(&fd);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn bunwasm_fd_closed(fd: c_int) {
    PATHS.with_borrow_mut(|m| m.remove(&fd));
}

/// Writes the path `fd` was opened at into `buf`. Returns its length, or
/// `-errno` (`EBADF` if unknown, `ENAMETOOLONG` if `buf` is too small).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunwasm_fd_path(fd: c_int, buf: *mut u8, cap: usize) -> isize {
    let Some(path) = path_of(fd) else {
        return -(libc::EBADF as isize);
    };
    if path.len() > cap {
        return -(libc::ENAMETOOLONG as isize);
    }
    // SAFETY: `buf` is writable for `cap >= path.len()` bytes.
    unsafe { core::ptr::copy_nonoverlapping(path.as_ptr(), buf, path.len()) };
    path.len() as isize
}

#[cfg(test)]
mod tests {
    use super::join;

    #[test]
    fn joins() {
        assert_eq!(join(b"/proj", b"src/./a/../b"), b"/proj/src/b");
        assert_eq!(join(b"/proj", b"/x/y/"), b"/x/y");
        assert_eq!(join(b"/", b".."), b"/");
    }
}
