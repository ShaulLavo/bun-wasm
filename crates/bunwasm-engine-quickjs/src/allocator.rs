use std::alloc::{GlobalAlloc, Layout};
use std::ffi::c_void;

pub(crate) struct CoreAllocator;

unsafe extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
    fn realloc(ptr: *mut c_void, size: usize) -> *mut c_void;
    fn posix_memalign(out: *mut *mut c_void, align: usize, size: usize) -> i32;
}

unsafe impl GlobalAlloc for CoreAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.align() <= 16 {
            return unsafe { malloc(layout.size()).cast() };
        }
        let mut ptr = std::ptr::null_mut();
        if unsafe { posix_memalign(&mut ptr, layout.align(), layout.size()) } != 0 {
            return std::ptr::null_mut();
        }
        ptr.cast()
    }

    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        unsafe { free(ptr.cast()) };
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if layout.align() <= 16 {
            return unsafe { realloc(ptr.cast(), size).cast() };
        }
        let Ok(next_layout) = Layout::from_size_align(size, layout.align()) else {
            return std::ptr::null_mut();
        };
        let next = unsafe { self.alloc(next_layout) };
        if next.is_null() {
            return next;
        }
        unsafe { std::ptr::copy_nonoverlapping(ptr, next, layout.size().min(size)) };
        unsafe { self.dealloc(ptr, layout) };
        next
    }
}
