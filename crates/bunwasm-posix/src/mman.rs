//! `mmap` over the Rust allocator. Linear memory can't be remapped, so a
//! "mapping" is a page-aligned heap block: anonymous maps are zeroed, private
//! file maps are filled with `pread`. Shared writable file maps are refused.
use core::ffi::{c_int, c_void};
use std::alloc::{Layout, alloc_zeroed, dealloc};

use libc::{off_t, size_t};

const PAGE: usize = 65536;

fn layout(len: usize) -> Option<Layout> {
    Layout::from_size_align(len.max(1).next_multiple_of(PAGE), PAGE).ok()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mmap(
    addr: *mut c_void,
    len: size_t,
    prot: c_int,
    flags: c_int,
    fd: c_int,
    off: off_t,
) -> *mut c_void {
    let _ = addr;
    if len == 0 || flags & libc::MAP_FIXED != 0 {
        crate::set_errno(libc::EINVAL);
        return libc::MAP_FAILED;
    }
    let anonymous = flags & libc::MAP_ANONYMOUS != 0;
    if !anonymous && flags & libc::MAP_SHARED != 0 && prot & libc::PROT_WRITE != 0 {
        crate::set_errno(libc::ENOTSUP);
        return libc::MAP_FAILED;
    }
    let Some(layout) = layout(len) else {
        crate::set_errno(libc::ENOMEM);
        return libc::MAP_FAILED;
    };
    // SAFETY: non-zero size layout.
    let ptr = unsafe { alloc_zeroed(layout) };
    if ptr.is_null() {
        crate::set_errno(libc::ENOMEM);
        return libc::MAP_FAILED;
    }
    if !anonymous {
        let mut done = 0usize;
        while done < len {
            // SAFETY: ptr..ptr+len is our allocation.
            let n = unsafe { libc::pread(fd, ptr.add(done).cast(), len - done, off + done as off_t) };
            if n < 0 {
                // SAFETY: allocated above with this layout.
                unsafe { dealloc(ptr, layout) };
                return libc::MAP_FAILED;
            }
            if n == 0 {
                break; // past EOF reads as zeros, like a real mapping
            }
            done += n as usize;
        }
    }
    ptr.cast()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn munmap(addr: *mut c_void, len: size_t) -> c_int {
    match layout(len) {
        Some(layout) if !addr.is_null() => {
            // SAFETY: `addr` came from `mmap` with the same rounded length.
            unsafe { dealloc(addr.cast(), layout) };
            0
        }
        _ => crate::fail(libc::EINVAL),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn mprotect(_addr: *mut c_void, _len: size_t, _prot: c_int) -> c_int {
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn msync(_addr: *mut c_void, _len: size_t, _flags: c_int) -> c_int {
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn madvise(_addr: *mut c_void, _len: size_t, _advice: c_int) -> c_int {
    0
}
