pub(crate) struct TransportBuffer {
    pub(crate) pointer: u32,
    pub(crate) bytes: u32,
}

impl TransportBuffer {
    pub(crate) fn new(bytes: u32) -> Self {
        let pointer = unsafe { bun_core_alloc(bytes, 8) };
        assert_ne!(pointer, 0, "transport allocation");
        Self { pointer, bytes }
    }
}

impl Drop for TransportBuffer {
    fn drop(&mut self) {
        unsafe { bun_core_free(self.pointer, self.bytes, 8) };
    }
}

unsafe extern "C" {
    pub(crate) fn bun_core_alloc(bytes: u32, align: u32) -> u32;
    pub(crate) fn bun_core_free(pointer: u32, bytes: u32, align: u32);
    pub(crate) fn bun_core_dispatch(frame: u32) -> u32;
    pub(crate) fn bun_core_idle(ms: i32);
    pub(crate) fn bun_core_poll(ms: i32) -> i32;
    pub(crate) fn bun_core_exit(code: i32) -> !;
    pub(crate) fn core_checkpoint() -> u32;
}
