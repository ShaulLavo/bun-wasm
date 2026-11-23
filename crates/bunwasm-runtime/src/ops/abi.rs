//! Allocation-checked physical frame transport. No slice covers raw linear memory.

use std::alloc::{Layout, alloc_zeroed, dealloc};
use std::cell::{Cell, Ref, RefCell};
use std::ptr::NonNull;

use super::{Dispatcher, Frame, Reply, Status, WordFrame, error_status};
use crate::data::codec::{self, CodecError};
use crate::data::{NativeError, Val, drop_tree};

/// One live transport allocation: zeroed memory the transport obtained with exactly this layout.
/// The transport frees it once; a copy is valid while the allocation is live.
#[derive(Clone, Copy)]
struct Span {
    pointer: NonNull<u8>,
    layout: Layout,
}

impl Span {
    #[cfg(any(test, not(feature = "engine-split"), bun_wasm_shared_group))]
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
        // SAFETY: the live allocation owns exactly layout.size initialized bytes.
        unsafe { std::slice::from_raw_parts(self.pointer.as_ptr(), self.layout.size()) }
    }

    /// Encodes into a fresh allocation. Nothing else has seen its pointer, so no other borrow of
    /// its bytes exists.
    fn encode(&self, value: &Val) -> Result<(), CodecError> {
        // SAFETY: the live allocation owns exactly layout.size initialized bytes.
        let bytes =
            unsafe { std::slice::from_raw_parts_mut(self.pointer.as_ptr(), self.layout.size()) };
        codec::encode_into(value, bytes)
    }

    fn encode_error(&self, error: &NativeError) -> Result<(), CodecError> {
        // SAFETY: this fresh allocation owns exactly layout.size initialized bytes.
        let bytes =
            unsafe { std::slice::from_raw_parts_mut(self.pointer.as_ptr(), self.layout.size()) };
        codec::encode_error_into(error, bytes)
    }

    fn write(&self, bytes: &[u8]) {
        assert_eq!(bytes.len(), self.layout.size());
        self.write_at(0, bytes);
    }

    fn write_at(&self, offset: usize, bytes: &[u8]) {
        assert!(offset + bytes.len() <= self.layout.size());
        // SAFETY: the range lies inside the layout.size initialized bytes this allocation owns,
        // disjoint from bytes.
        unsafe {
            std::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                self.pointer.as_ptr().add(offset),
                bytes.len(),
            )
        };
    }
}

/// Runs a word call inside its frame. Nothing on this path allocates, so the call ends with
/// its result in the frame or as a broken call, never as a resource limit.
fn word(dispatcher: &Dispatcher, frame: &Span) -> Result<Status, Status> {
    let call = WordFrame::decode(frame.bytes())?;
    let result = dispatcher
        .word(call.op, call.session, &call.words)
        .ok_or(Status::BadCall)?;
    frame.write_at(WordFrame::RESULT, &result.to_le_bytes());
    Ok(Status::Ok)
}

/// One live allocation. `pins` counts the running calls that use it as their frame or request:
/// a pinned allocation cannot be freed, and a pinned frame cannot be entered again.
struct Slot {
    offset: u32,
    span: Span,
    pins: Cell<u32>,
}

/// Unpins one allocation when its call returns, including when a native unwinds. It only
/// counts, so pinning never allocates.
struct Pin<'a> {
    transport: &'a Transport,
    offset: u32,
}

impl Drop for Pin<'_> {
    fn drop(&mut self) {
        // A pinned allocation cannot be freed, so its slot is still listed.
        if let Some(slot) = self.transport.slot(self.offset) {
            slot.pins.set(slot.pins.get() - 1);
        }
    }
}

/// Core owns this allocator. Only allocations made here are legal frame/payload spans.
/// Native tests assign synthetic linear offsets; wasm uses the actual wasm32 pointers.
#[derive(Default)]
pub(crate) struct Transport {
    /// Live allocations, oldest first. A call's own frame, request and reply are the newest, so
    /// lookups search from the end.
    allocations: RefCell<Vec<Slot>>,
    #[cfg(not(target_arch = "wasm32"))]
    next_offset: Cell<u32>,
}

impl Drop for Transport {
    fn drop(&mut self) {
        for Slot { span, .. } in self.allocations.get_mut().drain(..) {
            // SAFETY: each live span was obtained with alloc_zeroed and this exact layout.
            unsafe { dealloc(span.pointer.as_ptr(), span.layout) };
        }
    }
}

impl Transport {
    pub fn alloc(&self, bytes: u32, align: u32) -> u32 {
        self.allocate(bytes, align).map_or(0, |(offset, _)| offset)
    }

    fn allocate(&self, bytes: u32, align: u32) -> Option<(u32, Span)> {
        let layout = Layout::from_size_align(bytes as usize, align as usize).ok()?;
        let mut allocations = self.allocations.borrow_mut();
        if bytes == 0 || allocations.try_reserve(1).is_err() {
            return None;
        }
        // SAFETY: the nonzero size and alignment were checked by Layout.
        let pointer = NonNull::new(unsafe { alloc_zeroed(layout) })?;
        let span = Span { pointer, layout };
        let Some(offset) = self.offset(pointer, bytes, align) else {
            // SAFETY: obtained just above with this layout and never shared.
            unsafe { dealloc(pointer.as_ptr(), layout) };
            return None;
        };
        allocations.push(Slot {
            offset,
            span,
            pins: Cell::new(0),
        });
        Some((offset, span))
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
            .rposition(|slot| slot.offset == pointer)
            .ok_or(Status::BadCall)?;
        let slot = &allocations[index];
        let span = slot.span;
        if span.layout.size() != bytes as usize || span.layout.align() != align as usize {
            return Err(Status::BadCall);
        }
        if slot.pins.get() != 0 {
            return Err(Status::BadCall);
        }
        // `remove` keeps the oldest-first order; the freed span is usually among the newest.
        allocations.remove(index);
        drop(allocations);
        // SAFETY: the span was obtained with alloc_zeroed and this exact layout, and it is no
        // longer listed, so nothing reaches it again.
        unsafe { dealloc(span.pointer.as_ptr(), span.layout) };
        Ok(())
    }

    /// The live allocation at `pointer`, borrowed from the list.
    fn slot(&self, pointer: u32) -> Option<Ref<'_, Slot>> {
        let allocations = self.allocations.borrow();
        let index = allocations
            .iter()
            .rposition(|slot| slot.offset == pointer)?;
        Some(Ref::map(allocations, |allocations| &allocations[index]))
    }

    /// Pins the live frame-aligned allocation at `pointer` until the guard drops. A frame
    /// (`idle`) must not be in use by a running call already.
    fn pin(&self, pointer: u32, idle: bool) -> Result<(Span, Pin<'_>), Status> {
        let slot = self.slot(pointer).ok_or(Status::BadCall)?;
        if slot.span.layout.align() < Frame::ALIGN as usize || (idle && slot.pins.get() != 0) {
            return Err(Status::BadCall);
        }
        slot.pins.set(slot.pins.get() + 1);
        let pin = Pin {
            transport: self,
            offset: pointer,
        };
        Ok((slot.span, pin))
    }

    #[cfg(any(test, not(feature = "engine-split"), bun_wasm_shared_group))]
    /// The live frame-aligned allocation at `pointer` of exactly `bytes` bytes.
    fn allocation(&self, pointer: u32, bytes: u32) -> Result<Span, Status> {
        let slot = self.slot(pointer).ok_or(Status::BadCall)?;
        let layout = slot.span.layout;
        if layout.align() < Frame::ALIGN as usize || layout.size() != bytes as usize {
            return Err(Status::BadCall);
        }
        Ok(slot.span)
    }

    /// Encodes `value` into one allocation of exactly its encoded length, the only copy of the
    /// encoded bytes. Returns the allocation's pointer and length.
    pub fn encode(&self, value: &Val) -> Result<(u32, u32), CodecError> {
        self.encode_payload(codec::encoded_len(value)?, |span| span.encode(value))
    }

    fn encode_error(&self, error: &NativeError) -> Result<(u32, u32), CodecError> {
        self.encode_payload(codec::encoded_error_len(error)?, |span| {
            span.encode_error(error)
        })
    }

    fn encode_payload(
        &self,
        len: usize,
        fill: impl FnOnce(&Span) -> Result<(), CodecError>,
    ) -> Result<(u32, u32), CodecError> {
        let len = u32::try_from(len).map_err(|_| CodecError::Allocation)?;
        let (pointer, span) = self
            .allocate(len, Frame::ALIGN)
            .ok_or(CodecError::Allocation)?;
        if let Err(error) = fill(&span) {
            self.free(pointer, len, Frame::ALIGN)
                .expect("fresh transport allocation");
            return Err(error);
        }
        Ok((pointer, len))
    }

    #[cfg(any(test, not(feature = "engine-split")))]
    pub fn write(&self, pointer: u32, bytes: &[u8]) -> Result<(), Status> {
        let len = u32::try_from(bytes.len()).map_err(|_| Status::BadCall)?;
        self.allocation(pointer, len)?.write(bytes);
        Ok(())
    }

    #[cfg(any(test, not(feature = "engine-split"), bun_wasm_shared_group))]
    pub fn read(&self, pointer: u32, bytes: u32) -> Result<Vec<u8>, Status> {
        self.allocation(pointer, bytes)?.copy()
    }

    #[cfg(any(test, bun_wasm_shared_group))]
    pub fn validate(&self, pointer: u32, bytes: u32) -> Result<(), Status> {
        self.allocation(pointer, bytes).map(|_| ())
    }

    pub fn dispatch(&self, dispatcher: &Dispatcher, frame_ptr: u32) -> Status {
        match self.call(dispatcher, frame_ptr) {
            Ok(status) => status,
            Err(status) => status,
        }
    }

    fn call(&self, dispatcher: &Dispatcher, frame_ptr: u32) -> Result<Status, Status> {
        // A running call pins its frame, word or data, rejecting free/reuse and recursive entry
        // of that frame until it returns.
        let (frame_span, _frame_pin) = self.pin(frame_ptr, true)?;
        if frame_span.layout.size() == WordFrame::SIZE {
            return word(dispatcher, &frame_span);
        }
        if frame_span.layout.size() != Frame::SIZE {
            return Err(Status::BadCall);
        }
        let mut frame_bytes = [0; Frame::SIZE];
        frame_bytes.copy_from_slice(frame_span.bytes());
        let frame = Frame::decode(&frame_bytes)?;
        frame.request(frame_ptr, memory_len())?;
        // The engine may reuse one request buffer, so the request is a prefix of its allocation.
        let (request, request_pin) = self.pin(frame.request_ptr, false)?;
        let request_len = frame.request_len as usize;
        if request_len > request.layout.size() {
            return Err(Status::BadCall);
        }
        // Decode the request where the engine wrote it; a copy would hold the payload twice.
        let reply = dispatcher.dispatch(frame.op, frame.session, &request.bytes()[..request_len]);
        drop(request_pin);
        let status = reply.status();
        let encoded = match reply {
            Reply::Value(value) => {
                let encoded = self.encode(&value);
                drop_tree(value);
                encoded
            }
            Reply::NativeError(error) => {
                let encoded = self.encode_error(&error);
                drop_tree(Val::Object(error.props));
                encoded
            }
            Reply::Failed(status) => return Ok(status),
        };
        let (pointer, len) = encoded.map_err(error_status)?;
        frame_bytes[16..20].copy_from_slice(&pointer.to_le_bytes());
        frame_bytes[20..24].copy_from_slice(&len.to_le_bytes());
        frame_span.write(&frame_bytes);
        Ok(status)
    }

    /// Makes every later synthetic offset overflow, as if core memory were exhausted.
    #[cfg(test)]
    pub fn exhaust(&self) {
        self.next_offset.set(u32::MAX);
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
    use crate::data::NativeError;
    let transport = Transport::default();
    let args = Val::Array(args);
    let request = transport.encode(&args);
    drop_tree(args);
    let (request_ptr, request_len) = request.map_err(super::transport_error)?;
    let frame_ptr = transport.alloc(Frame::SIZE as u32, Frame::ALIGN);
    if frame_ptr == 0 {
        return Err(NativeError::error("core data allocation failed"));
    }
    let frame = frame_bytes(op, session, request_ptr, request_len);
    transport.write(frame_ptr, &frame).map_err(call_error)?;
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
    super::Reply::decode(status, &bytes)
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

#[cfg(test)]
mod nested_frame_controls {
    use super::*;

    #[test]
    fn failed_fill_releases_the_fresh_payload() {
        let transport = Transport::default();
        assert_eq!(
            transport.encode_payload(8, |_| Err(CodecError::Allocation)),
            Err(CodecError::Allocation)
        );
        assert_eq!(transport.live_allocations(), 0);
    }

    #[test]
    fn validation_requires_an_exact_live_owned_frame_without_retaining_it() {
        let transport = Transport::default();
        let pointer = transport.alloc(520, Frame::ALIGN);
        assert_ne!(pointer, 0);
        assert!(transport.validate(pointer, 520).is_ok());
        assert!(transport.validate(pointer, 519).is_err());
        assert!(transport.validate(pointer + 1, 520).is_err());
        transport.free(pointer, 520, Frame::ALIGN).unwrap();
        assert!(transport.validate(pointer, 520).is_err());
    }
}
