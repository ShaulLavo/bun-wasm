//! Allocation-checked physical frame transport. No slice covers raw linear memory.

use std::alloc::{Layout, alloc_zeroed, dealloc};
#[cfg(not(target_arch = "wasm32"))]
use std::cell::Cell;
use std::cell::RefCell;
use std::ptr::NonNull;
use std::rc::Rc;

use super::{Dispatcher, Frame, Status};

struct Allocation {
    pointer: NonNull<u8>,
    layout: Layout,
}

impl Allocation {
    fn copy(&self) -> Result<Vec<u8>, Status> {
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(self.layout.size())
            .map_err(|_| Status::ResourceLimit)?;
        // SAFETY: only initialized, live transport allocations can reach this method.
        unsafe {
            std::ptr::copy_nonoverlapping(
                self.pointer.as_ptr(),
                bytes.as_mut_ptr(),
                self.layout.size(),
            );
            bytes.set_len(self.layout.size());
        }
        Ok(bytes)
    }

    /// Reads the allocation in place. Core owns it, and the engine that wrote it is blocked in
    /// the dispatch that holds this borrow, so nothing writes it meanwhile.
    fn bytes(&self) -> &[u8] {
        // SAFETY: allocation owns exactly layout.size initialized bytes, live while self is.
        unsafe { std::slice::from_raw_parts(self.pointer.as_ptr(), self.layout.size()) }
    }

    fn write(&self, bytes: &[u8]) {
        assert_eq!(bytes.len(), self.layout.size());
        // SAFETY: allocation owns exactly layout.size initialized bytes, disjoint from bytes.
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.pointer.as_ptr(), bytes.len())
        };
    }
}

impl Drop for Allocation {
    fn drop(&mut self) {
        // SAFETY: this allocation was obtained with alloc_zeroed and this exact layout.
        unsafe { dealloc(self.pointer.as_ptr(), self.layout) };
    }
}

/// Core owns this allocator. Only allocations made here are legal frame/payload spans.
/// Native tests assign synthetic linear offsets; wasm uses the actual wasm32 pointers.
#[derive(Default)]
pub(crate) struct Transport {
    allocations: RefCell<Vec<(u32, Rc<Allocation>)>>,
    #[cfg(not(target_arch = "wasm32"))]
    next_offset: Cell<u32>,
}

impl Transport {
    pub fn alloc(&self, bytes: u32, align: u32) -> u32 {
        let Ok(layout) = Layout::from_size_align(bytes as usize, align as usize) else {
            return 0;
        };
        if bytes == 0 || self.allocations.borrow_mut().try_reserve(1).is_err() {
            return 0;
        }
        // SAFETY: the nonzero size and alignment were checked by Layout.
        let Some(pointer) = NonNull::new(unsafe { alloc_zeroed(layout) }) else {
            return 0;
        };
        let allocation = Rc::new(Allocation { pointer, layout });
        let Some(offset) = self.offset(pointer, bytes, align) else {
            return 0;
        };
        self.allocations.borrow_mut().push((offset, allocation));
        offset
    }

    #[cfg(target_arch = "wasm32")]
    fn offset(&self, pointer: NonNull<u8>, _: u32, _: u32) -> Option<u32> {
        Some(pointer.as_ptr() as u32)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn offset(&self, _: NonNull<u8>, bytes: u32, align: u32) -> Option<u32> {
        let start = self.next_offset.get().max(Frame::ALIGN);
        let start = start.checked_add(align - 1)? & !(align - 1);
        self.next_offset.set(start.checked_add(bytes)?);
        Some(start)
    }

    pub fn free(&self, pointer: u32, bytes: u32, align: u32) -> Result<(), Status> {
        let mut allocations = self.allocations.borrow_mut();
        let index = allocations
            .iter()
            .position(|(p, _)| *p == pointer)
            .ok_or(Status::BadCall)?;
        let allocation = &allocations[index].1;
        if allocation.layout.size() != bytes as usize || allocation.layout.align() != align as usize
        {
            return Err(Status::BadCall);
        }
        if Rc::strong_count(allocation) != 1 {
            return Err(Status::BadCall);
        }
        let removed = allocations.swap_remove(index);
        drop(allocations);
        drop(removed);
        Ok(())
    }

    fn allocation(&self, pointer: u32, bytes: u32) -> Result<Rc<Allocation>, Status> {
        let allocations = self.allocations.borrow();
        let (_, allocation) = allocations
            .iter()
            .find(|(p, _)| *p == pointer)
            .ok_or(Status::BadCall)?;
        if allocation.layout.size() != bytes as usize
            || allocation.layout.align() < Frame::ALIGN as usize
        {
            return Err(Status::BadCall);
        }
        Ok(allocation.clone())
    }

    pub fn write(&self, pointer: u32, bytes: &[u8]) -> Result<(), Status> {
        let len = u32::try_from(bytes.len()).map_err(|_| Status::BadCall)?;
        self.allocation(pointer, len)?.write(bytes);
        Ok(())
    }

    #[cfg(any(test, not(feature = "engine-split")))]
    pub fn read(&self, pointer: u32, bytes: u32) -> Result<Vec<u8>, Status> {
        self.allocation(pointer, bytes)?.copy()
    }

    pub fn dispatch(&self, dispatcher: &Dispatcher, frame_ptr: u32) -> Status {
        match self.call(dispatcher, frame_ptr) {
            Ok(status) => status,
            Err(status) => status,
        }
    }

    fn call(&self, dispatcher: &Dispatcher, frame_ptr: u32) -> Result<Status, Status> {
        let frame_owner = self.allocation(frame_ptr, Frame::SIZE as u32)?;
        // A live call pins its frame, rejecting free/reuse and recursive entry of that frame.
        if Rc::strong_count(&frame_owner) != 2 {
            return Err(Status::BadCall);
        }
        let mut frame_bytes = frame_owner.copy()?;
        let frame = Frame::decode(&frame_bytes)?;
        frame.request(frame_ptr, memory_len())?;
        // Decode the request where the engine wrote it; a copy would hold the payload twice.
        let request = self.allocation(frame.request_ptr, frame.request_len)?;
        let reply = dispatcher.dispatch(frame.op, frame.session, request.bytes());
        drop(request);
        let len = u32::try_from(reply.bytes.len()).map_err(|_| Status::ResourceLimit)?;
        if len == 0 {
            return Ok(reply.status);
        }
        let pointer = self.alloc(len, Frame::ALIGN);
        if pointer == 0 {
            return Err(Status::ResourceLimit);
        }
        self.write(pointer, &reply.bytes)?;
        frame_bytes[16..20].copy_from_slice(&pointer.to_le_bytes());
        frame_bytes[20..24].copy_from_slice(&len.to_le_bytes());
        frame_owner.write(&frame_bytes);
        Ok(reply.status)
    }

    #[cfg(test)]
    pub fn live_allocations(&self) -> usize {
        self.allocations.borrow().len()
    }
}

#[cfg(target_arch = "wasm32")]
fn memory_len() -> usize {
    std::arch::wasm32::memory_size::<0>() * 65_536
}

#[cfg(not(target_arch = "wasm32"))]
fn memory_len() -> usize {
    u32::MAX as usize + 1
}

#[cfg(any(test, not(feature = "engine-split")))]
pub(super) fn call(
    dispatcher: &Dispatcher,
    op: u32,
    session: u32,
    args: Vec<crate::data::Val>,
) -> crate::data::NativeResult {
    use crate::data::{NativeError, Val};
    let transport = Transport::default();
    let args = Val::Array(args);
    let request = super::codec::encode(&args);
    crate::data::drop_tree(args);
    let request = request.map_err(super::transport_error)?;
    let request_len = u32::try_from(request.len())
        .map_err(|_| NativeError::error("core data request too large"))?;
    let request_ptr = transport.alloc(request_len, Frame::ALIGN);
    let frame_ptr = transport.alloc(Frame::SIZE as u32, Frame::ALIGN);
    if request_ptr == 0 || frame_ptr == 0 {
        return Err(NativeError::error("core data allocation failed"));
    }
    let frame = frame_bytes(op, session, request_ptr, request_len);
    transport.write(request_ptr, &request).map_err(call_error)?;
    transport.write(frame_ptr, &frame).map_err(call_error)?;
    drop(request);
    let status = transport.dispatch(dispatcher, frame_ptr);
    let frame = Frame::decode(
        &transport
            .read(frame_ptr, Frame::SIZE as u32)
            .map_err(call_error)?,
    )
    .map_err(call_error)?;
    let bytes = read_reply(&transport, frame)?;
    transport
        .free(request_ptr, request_len, Frame::ALIGN)
        .map_err(call_error)?;
    transport
        .free(frame_ptr, Frame::SIZE as u32, Frame::ALIGN)
        .map_err(call_error)?;
    super::Reply { status, bytes }.into_result()
}

#[cfg(any(test, not(feature = "engine-split")))]
pub(super) fn frame_bytes(op: u32, session: u32, pointer: u32, len: u32) -> [u8; Frame::SIZE] {
    let mut frame = [0; Frame::SIZE];
    for (index, word) in [op, session, pointer, len, 0, 0].into_iter().enumerate() {
        frame[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    frame
}

#[cfg(any(test, not(feature = "engine-split")))]
fn read_reply(transport: &Transport, frame: Frame) -> Result<Vec<u8>, crate::data::NativeError> {
    if frame.reply_len == 0 {
        return Ok(Vec::new());
    }
    let bytes = transport
        .read(frame.reply_ptr, frame.reply_len)
        .map_err(call_error)?;
    transport
        .free(frame.reply_ptr, frame.reply_len, Frame::ALIGN)
        .map_err(call_error)?;
    Ok(bytes)
}

#[cfg(any(test, not(feature = "engine-split")))]
fn call_error(status: Status) -> crate::data::NativeError {
    match status {
        Status::ResourceLimit => crate::data::NativeError::error("core data allocation failed"),
        _ => crate::data::NativeError::error("invalid core transport allocation"),
    }
}
