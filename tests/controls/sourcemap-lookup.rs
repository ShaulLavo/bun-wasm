#[path = "sourcemap.rs"]
mod sourcemap;

use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

#[derive(Default)]
struct PositionMap {
    record: Option<sourcemap::SourceMap>,
    map: Option<sourcemap::SourceMap>,
    line1_shift: u32,
    line_offset: u32,
}

// PRODUCTION_POSITION_MAP

struct CountingAllocator;
static ARMED: AtomicBool = AtomicBool::new(false);
static CALLS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);

fn record(bytes: usize) {
    if ARMED.load(Relaxed) {
        CALLS.fetch_add(1, Relaxed);
        BYTES.fetch_add(bytes, Relaxed);
    }
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn measured(map: &sourcemap::SourceMap, line: u32, col: u32) -> Option<(u32, u32)> {
    CALLS.store(0, Relaxed);
    BYTES.store(0, Relaxed);
    ARMED.store(true, Relaxed);
    let result = map.lookup(black_box(line), black_box(col));
    ARMED.store(false, Relaxed);
    let calls = CALLS.load(Relaxed);
    let bytes = BYTES.load(Relaxed);
    println!("query {line}:{col}: {calls} allocation requests, {bytes} cumulative requested bytes");
    assert_eq!((calls, bytes), (0, 0));
    result
}

fn composition() {
    let positions = PositionMap {
        record: Some(sourcemap::SourceMap::new("oGCCG;ADCH")),
        line1_shift: 3,
        line_offset: 1,
        map: Some(sourcemap::SourceMap::new("ACEK;ADCA")),
    };
    assert_eq!(positions.original_position(1, 101), (3, 6));
    assert_eq!(positions.original_position(2, 1), (4, 6));
}

fn timed(map: &sourcemap::SourceMap, label: &str, queries: impl Iterator<Item = (u32, u32)>) {
    let start = Instant::now();
    let mut count = 0;
    for (line, col) in queries {
        black_box(map.lookup(black_box(line), black_box(col)));
        count += 1;
    }
    println!("{label}: {count} queries in {:?}", start.elapsed());
}

fn main() {
    println!(
        "SourceMap state: {} bytes",
        std::mem::size_of::<sourcemap::SourceMap>()
    );
    composition();
    for suffix in [0, 8192, 131072] {
        let map = sourcemap::SourceMap::new("AAAA".to_owned() + &";AAAA".repeat(suffix));
        println!("{suffix} suffix lines");
        assert_eq!(measured(&map, 0, 1), None);
        assert_eq!(measured(&map, 1, 1), Some((1, 1)));
        assert_eq!(measured(&map, 1, 1), Some((1, 1)));
        assert_eq!(measured(&map, suffix as u32 + 2, 1), None);
        assert_eq!(measured(&map, suffix as u32 + 1, 3), Some((1, 3)));
    }
    let map = sourcemap::SourceMap::new("AAAA,".repeat(131072));
    assert_eq!(measured(&map, 1, 1), Some((1, 1)));
    timed(&map, "dense repeated position", (0..100000).map(|_| (1, 1)));
    timed(
        &map,
        "dense alternating columns",
        (0..100).map(|i| (1, 1 + i % 2)),
    );
    let map = sourcemap::SourceMap::new("AAAA".to_owned() + &";AAAA".repeat(8192));
    timed(&map, "forward", (1..=8193).map(|line| (line, 1)));
    timed(
        &map,
        "repeated late position",
        (0..100000).map(|_| (8193, 1)),
    );
    timed(
        &map,
        "alternating first/last",
        (0..100).map(|i| (if i % 2 == 0 { 1 } else { 8193 }, 1)),
    );
}
