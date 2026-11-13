use crate::data::Val;
use crate::ops;
use crate::transport::{TransportBuffer, bun_core_dispatch};

/// One process-owned frame and empty request. TAKE_TICK invokes no engine code,
/// so the caller can reuse this packet without holding it across a JS callback.
pub(crate) struct TickRequest {
    frame: TransportBuffer,
    request: TransportBuffer,
}

impl TickRequest {
    pub(crate) fn new() -> Self {
        let request = super::request(&Val::Array(vec![])).expect("encode take nextTick");
        let frame = TransportBuffer::new(24).expect("take nextTick allocation");
        Self { frame, request }
    }

    pub(crate) fn take(&mut self, session: u32) -> bool {
        let frame = self.frame.pointer;
        let words = [
            crate::split_api::TAKE_TICK,
            session,
            self.request.pointer,
            self.request.bytes,
            0,
            0,
        ];
        // SAFETY: the packet owns this 24-byte frame. Reset both reply words each
        // call; dispatch checks the request and frame are distinct owned allocations.
        unsafe { std::ptr::copy_nonoverlapping(words.as_ptr(), frame as *mut u32, words.len()) };
        let status = match unsafe { bun_core_dispatch(frame) } {
            0 => ops::Status::Ok,
            1 => ops::Status::NativeError,
            3 => ops::Status::ResourceLimit,
            status => panic!("terminal core transport failure {status}"),
        };
        let pointer = unsafe { (frame as *const u32).add(4).read() };
        let bytes = unsafe { (frame as *const u32).add(5).read() };
        if status == ops::Status::ResourceLimit {
            assert!(
                pointer == 0 && bytes == 0,
                "core resource limit with a reply"
            );
            panic!("take nextTick: core data allocation failed");
        }
        let reply = TransportBuffer { pointer, bytes };
        let bytes = if reply.bytes == 0 {
            &[]
        } else {
            // SAFETY: core owns this initialized reply until its buffer is dropped.
            unsafe { std::slice::from_raw_parts(reply.pointer as *const u8, reply.bytes as usize) }
        };
        ops::Reply::decode(status, bytes).expect("take nextTick") == Val::Bool(true)
    }
}
