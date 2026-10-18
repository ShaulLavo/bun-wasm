//! Host-only ABI hooks. WASI uses Bun's scalar XML producer directly.
use core::ffi::{c_char, c_int};

#[unsafe(no_mangle)]
extern "C" fn Bun__linux_trace_init() -> c_int {
    0 // This adapter does not install Bun's Linux ftrace backend.
}

#[unsafe(no_mangle)]
extern "C" fn Bun__linux_trace_emit(_event: *const c_char, _duration_ns: i64) -> c_int {
    0
}

fn structural(unit: u16, in_tag: &mut bool) -> bool {
    match unit {
        60 => {
            *in_tag = true;
            true
        }
        62 => {
            *in_tag = false;
            true
        }
        38 | 13 | 0..=8 | 11 | 12 | 14..=31 | 0xfffe | 0xffff => true,
        9 | 10 | 34 | 39 | 61 => *in_tag,
        _ => false,
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_xml_index_chunk(
    input: *const u8,
    len: usize,
    base: usize,
    out: *mut u32,
    state: *mut u64,
) -> usize {
    // SAFETY: Bun's wrapper supplies len readable units, len+64 output slots,
    // and three state words. Each unit emits at most one output index.
    let (input, out, state) = unsafe {
        (
            core::slice::from_raw_parts(input, len),
            core::slice::from_raw_parts_mut(out.cast::<core::mem::MaybeUninit<u32>>(), len + 64),
            core::slice::from_raw_parts_mut(state, 3),
        )
    };
    let mut in_tag = state[0] != 0;
    let mut previous = state[2];
    let mut written = 0;
    for (index, &byte) in input.iter().enumerate() {
        let noncharacter = matches!(byte, 0xbe | 0xbf) && previous & 0xffff == 0xefbf;
        if structural(u16::from(byte), &mut in_tag) || noncharacter {
            out[written].write((base + index) as u32);
            written += 1;
        }
        previous = ((previous << 8) | u64::from(byte)) & 0xffff;
    }
    state[0] = u64::from(in_tag);
    state[2] = previous;
    written
}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_xml_index16_chunk(
    input: *const u16,
    len: usize,
    base: usize,
    out: *mut u32,
    state: *mut u64,
) -> usize {
    // SAFETY: same wrapper contract as the byte producer, with UTF-16 units.
    let (input, out, state) = unsafe {
        (
            core::slice::from_raw_parts(input, len),
            core::slice::from_raw_parts_mut(out.cast::<core::mem::MaybeUninit<u32>>(), len + 64),
            core::slice::from_raw_parts_mut(state, 3),
        )
    };
    let mut in_tag = state[0] != 0;
    let mut pending_lead = state[1] != 0;
    let mut written = 0;
    for (index, &unit) in input.iter().enumerate() {
        let trail = (0xdc00..=0xdfff).contains(&unit);
        if pending_lead && !trail {
            out[written].write((base + index - 1) as u32);
            written += 1;
        }
        let lead = (0xd800..=0xdbff).contains(&unit);
        if structural(unit, &mut in_tag) || (trail && !pending_lead) {
            out[written].write((base + index) as u32);
            written += 1;
        }
        pending_lead = lead;
    }
    state[0] = u64::from(in_tag);
    state[1] = u64::from(pending_lead);
    written
}

#[cfg(test)]
mod tests {
    #[test]
    fn xml_byte_index_preserves_tag_and_noncharacter_state_across_chunks() {
        let mut state = [0; 3];
        let mut out = [0; 128];
        // SAFETY: all buffers satisfy the producer's documented ABI contract.
        let first = unsafe {
            super::highway_xml_index_chunk(
                b"<a x=\"".as_ptr(),
                6,
                0,
                out.as_mut_ptr(),
                state.as_mut_ptr(),
            )
        };
        assert_eq!(&out[..first], &[0, 4, 5]);
        let second = unsafe {
            super::highway_xml_index_chunk(
                b"v\">\xef\xbf".as_ptr(),
                5,
                6,
                out.as_mut_ptr(),
                state.as_mut_ptr(),
            )
        };
        assert_eq!(&out[..second], &[7, 8]);
        let third = unsafe {
            super::highway_xml_index_chunk(
                b"\xbe".as_ptr(),
                1,
                11,
                out.as_mut_ptr(),
                state.as_mut_ptr(),
            )
        };
        assert_eq!(&out[..third], &[11]);
    }

    #[test]
    fn xml_wide_index_detects_unpaired_surrogates_across_chunks() {
        let mut state = [0; 3];
        let mut out = [0; 128];
        let input = [60, 0xd800];
        // SAFETY: all buffers satisfy the producer's documented ABI contract.
        let first = unsafe {
            super::highway_xml_index16_chunk(
                input.as_ptr(),
                2,
                0,
                out.as_mut_ptr(),
                state.as_mut_ptr(),
            )
        };
        assert_eq!(&out[..first], &[0]);
        let input = [32, 0xdc00, 62, 0xfffe];
        let second = unsafe {
            super::highway_xml_index16_chunk(
                input.as_ptr(),
                4,
                2,
                out.as_mut_ptr(),
                state.as_mut_ptr(),
            )
        };
        assert_eq!(&out[..second], &[1, 3, 4, 5]);
    }
}
