use crate::{TransportBuffer, bun_core_dispatch};

pub(crate) fn write_stdout(session: u32, value: i32) {
    let output = format!("{value}\n");
    let mut bytes = vec![7];
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.push(6);
    bytes.extend_from_slice(&(output.len() as u32).to_le_bytes());
    bytes.extend_from_slice(output.as_bytes());
    bytes.push(3);
    let request = TransportBuffer::new(bytes.len() as u32);
    let frame = TransportBuffer::new(24);
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), request.pointer as *mut u8, bytes.len())
    };
    let words = [65_536u32, session, request.pointer, request.bytes, 0, 0];
    unsafe {
        std::ptr::copy_nonoverlapping(words.as_ptr(), frame.pointer as *mut u32, words.len())
    };
    assert_eq!(
        unsafe { bun_core_dispatch(frame.pointer) },
        0,
        "stdout dispatch"
    );
    let reply = TransportBuffer {
        pointer: unsafe { (frame.pointer as *const u32).add(4).read() },
        bytes: unsafe { (frame.pointer as *const u32).add(5).read() },
    };
    assert_eq!(reply.bytes, 1);
    assert_eq!(unsafe { (reply.pointer as *const u8).read() }, 0);
}
