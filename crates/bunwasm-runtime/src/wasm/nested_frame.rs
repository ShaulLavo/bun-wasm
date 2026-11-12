//! J11 private core/engine/host callback frame. All integers are little-endian.
pub const MAX_VALUES: usize = 32;
pub const MAX_DEPTH: usize = 64;
pub const OK: u32 = 0;
pub const PENDING_EXCEPTION: u32 = 2;
pub const BAD_FRAME: u32 = 3;

#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct Slot {
    pub kind: u32,
    pub reserved: u32,
    pub bits: u64,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub struct CallbackFrame {
    pub arguments: u32,
    pub results: u32,
    pub slots: [Slot; MAX_VALUES],
}

impl Default for CallbackFrame {
    fn default() -> Self {
        Self {
            arguments: 0,
            results: 0,
            slots: [Slot::default(); MAX_VALUES],
        }
    }
}

pub const FRAME_BYTES: u32 = std::mem::size_of::<CallbackFrame>() as u32;
const _: () = assert!(FRAME_BYTES == 520);

const _: () = assert!(OK == 0 && PENDING_EXCEPTION == 2 && BAD_FRAME == 3);
