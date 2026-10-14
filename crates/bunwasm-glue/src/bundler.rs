//! Symbols the bundler (`bun_bundler`, BundleV2) adds on top of the parser's:
//! the highway kernels it alone calls, streaming XXH64 for content hashes,
//! macro hooks, and a do-nothing uSockets loop for the mini event loop. Hooks
//! whose signatures use bundler types live in `bunwasm-build` (`stubs.rs`).
use core::ffi::c_void;

// ── highway ───────────────────────────────────────────────────────────────

/// Index of the first `\n`, `\r` or non-ASCII byte, or `len`.
#[unsafe(no_mangle)]
unsafe extern "C" fn highway_index_of_newline_or_non_ascii(p: *const u8, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    // SAFETY: the caller passes a slice, as a pointer and a length.
    let s = unsafe { core::slice::from_raw_parts(p, len) };
    s.iter().position(|&c| c == b'\n' || c == b'\r' || c > 127).unwrap_or(len)
}

/// Index of the first byte that is not `value`, or `len`.
#[unsafe(no_mangle)]
unsafe extern "C" fn highway_index_of_not_char(p: *const u8, len: usize, value: u8) -> usize {
    if len == 0 {
        return 0;
    }
    // SAFETY: the caller passes a slice, as a pointer and a length.
    let s = unsafe { core::slice::from_raw_parts(p, len) };
    s.iter().position(|&c| c != value).unwrap_or(len)
}

// ── XXH64 (reference algorithm; chunk names hash with it) ─────────────────

const P1: u64 = 0x9E37_79B1_85EB_CA87;
const P2: u64 = 0xC2B2_AE3D_27D4_EB4F;
const P3: u64 = 0x1656_67B1_9E37_79F9;
const P4: u64 = 0x85EB_CA77_C2B2_AE63;
const P5: u64 = 0x27D4_EB2F_1656_67C5;

#[inline]
fn round(acc: u64, input: u64) -> u64 {
    acc.wrapping_add(input.wrapping_mul(P2)).rotate_left(31).wrapping_mul(P1)
}

#[inline]
fn merge_round(acc: u64, val: u64) -> u64 {
    (acc ^ round(0, val)).wrapping_mul(P1).wrapping_add(P4)
}

#[inline]
fn read_u64(b: &[u8]) -> u64 {
    u64::from_le_bytes(b[..8].try_into().expect("8 bytes"))
}

#[inline]
fn read_u32(b: &[u8]) -> u32 {
    u32::from_le_bytes(b[..4].try_into().expect("4 bytes"))
}

fn finalize(mut h: u64, mut rest: &[u8]) -> u64 {
    while rest.len() >= 8 {
        h ^= round(0, read_u64(rest));
        h = h.rotate_left(27).wrapping_mul(P1).wrapping_add(P4);
        rest = &rest[8..];
    }
    if rest.len() >= 4 {
        h ^= u64::from(read_u32(rest)).wrapping_mul(P1);
        h = h.rotate_left(23).wrapping_mul(P2).wrapping_add(P3);
        rest = &rest[4..];
    }
    for &b in rest {
        h ^= u64::from(b).wrapping_mul(P5);
        h = h.rotate_left(11).wrapping_mul(P1);
    }
    h ^= h >> 33;
    h = h.wrapping_mul(P2);
    h ^= h >> 29;
    h = h.wrapping_mul(P3);
    h ^ (h >> 32)
}

/// Streaming state; fits the 80-byte, 8-aligned `XxHash64State` storage.
#[repr(C)]
struct Xxh64 {
    total_len: u64,
    v: [u64; 4],
    mem: [u8; 32],
    mem_size: u32,
    seed_low: u32,
}

const _: () = assert!(core::mem::size_of::<Xxh64>() <= 80);

impl Xxh64 {
    fn new(seed: u64) -> Self {
        Xxh64 {
            total_len: 0,
            v: [
                seed.wrapping_add(P1).wrapping_add(P2),
                seed.wrapping_add(P2),
                seed,
                seed.wrapping_sub(P1),
            ],
            mem: [0; 32],
            mem_size: 0,
            seed_low: 0,
        }
    }

    fn seed(&self) -> u64 {
        self.v[2]
    }

    fn stripes(&mut self, mut input: &[u8]) -> usize {
        let start = input.len();
        while input.len() >= 32 {
            for (i, lane) in self.v.iter_mut().enumerate() {
                *lane = round(*lane, read_u64(&input[i * 8..]));
            }
            input = &input[32..];
        }
        start - input.len()
    }

    fn update(&mut self, mut input: &[u8]) {
        self.total_len += input.len() as u64;
        let have = self.mem_size as usize;
        if have + input.len() < 32 {
            self.mem[have..have + input.len()].copy_from_slice(input);
            self.mem_size += input.len() as u32;
            return;
        }
        if have > 0 {
            let take = 32 - have;
            self.mem[have..].copy_from_slice(&input[..take]);
            let block = self.mem;
            self.stripes(&block);
            input = &input[take..];
            self.mem_size = 0;
        }
        let used = self.stripes(input);
        let rest = &input[used..];
        self.mem[..rest.len()].copy_from_slice(rest);
        self.mem_size = rest.len() as u32;
    }

    fn digest(&self) -> u64 {
        let h = if self.total_len >= 32 {
            let [v1, v2, v3, v4] = self.v;
            let mut h = v1
                .rotate_left(1)
                .wrapping_add(v2.rotate_left(7))
                .wrapping_add(v3.rotate_left(12))
                .wrapping_add(v4.rotate_left(18));
            for v in self.v {
                h = merge_round(h, v);
            }
            h
        } else {
            self.seed().wrapping_add(P5)
        };
        finalize(h.wrapping_add(self.total_len), &self.mem[..self.mem_size as usize])
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_xxhash64(input: *const u8, len: usize, seed: u64) -> u64 {
    let s = if len == 0 {
        &[][..]
    } else {
        // SAFETY: the caller passes a slice, as a pointer and a length.
        unsafe { core::slice::from_raw_parts(input, len) }
    };
    let mut h = Xxh64::new(seed);
    h.update(s);
    h.digest()
}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_xxhash64_reset(state: *mut u8, seed: u64) {
    // SAFETY: `state` is 80 bytes of 8-aligned storage (`XxHash64State`).
    unsafe { state.cast::<Xxh64>().write(Xxh64::new(seed)) };
}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_xxhash64_update(state: *mut u8, input: *const u8, len: usize) {
    if len == 0 {
        return;
    }
    // SAFETY: `state` was reset by `highway_xxhash64_reset`; `input` is a slice.
    unsafe { (*state.cast::<Xxh64>()).update(core::slice::from_raw_parts(input, len)) };
}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_xxhash64_digest(state: *const u8) -> u64 {
    // SAFETY: `state` was reset by `highway_xxhash64_reset`.
    unsafe { (*state.cast::<Xxh64>()).digest() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_shot(s: &[u8], seed: u64) -> u64 {
        // SAFETY: slice as pointer and length.
        unsafe { highway_xxhash64(s.as_ptr(), s.len(), seed) }
    }

    #[test]
    fn reference_vectors() {
        assert_eq!(one_shot(b"", 0), 0xEF46_DB37_51D8_E999);
        assert_eq!(one_shot(b"a", 0), 0xD24E_C4F1_A98C_6E5B);
        assert_eq!(one_shot(b"abc", 0), 0x44BC_2CF5_AD77_0999);
        let long: Vec<u8> = (0..1000u32).map(|i| (i * 7) as u8).collect();
        let mut h = Xxh64::new(5);
        for chunk in long.chunks(13) {
            h.update(chunk);
        }
        assert_eq!(h.digest(), one_shot(&long, 5));
    }
}

// ── macros: no JS engine, so no macro VM (see `__bun_macro_context_init`) ──

#[unsafe(no_mangle)]
unsafe fn __bun_macro_context_deinit(data: *mut c_void) {
    debug_assert!(data.is_null(), "macro contexts are never created in bun-wasm");
}

#[unsafe(no_mangle)]
fn __bun_macro_collect_vm_garbage() {}

// ── uSockets: a loop with no sockets ──────────────────────────────────────
//
// The bundler's mini event loop owns a uws loop it ticks while it waits for
// parse results. On single-threaded wasm the thread pool runs every task
// inline, so results are queued before the loop waits and nothing ever needs
// polling: the loop is zeroed memory and its operations do nothing.

/// `struct us_loop_t` is ~8 KiB on wasm32 (1024 `pollfd`s); 16 KiB of
/// 16-aligned zeroes covers it.
#[repr(C, align(16))]
struct FakeLoop([u8; 16384]);

#[unsafe(no_mangle)]
extern "C" fn uws_get_loop() -> *mut c_void {
    std::thread_local! {
        static LOOP: *mut FakeLoop = Box::into_raw(Box::new(FakeLoop([0; 16384])));
    }
    LOOP.with(|l| *l).cast()
}

#[unsafe(no_mangle)]
extern "C" fn us_wakeup_loop(_loop: *mut c_void) {}

#[unsafe(no_mangle)]
extern "C" fn us_loop_run_bun_tick(_loop: *mut c_void, _timeout: *const c_void, _now_ns: u64) {}
