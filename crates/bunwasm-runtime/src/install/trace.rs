//! Opt-in install phase timings: `BUN_WASM_INSTALL_TRACE=1 bun install` prints where the
//! wall time went (network waits, cache writes, hashing, extraction, publication) to stderr.
//! Disabled tracing costs one thread-local check per measured step.
use std::{
    cell::RefCell,
    collections::BTreeMap,
    time::{Duration, Instant},
};

#[derive(Default, Clone, Copy)]
struct Row {
    time: Duration,
    count: u64,
    bytes: u64,
}

thread_local! {
    static ROWS: RefCell<Option<BTreeMap<&'static str, Row>>> = const { RefCell::new(None) };
}

pub fn start() {
    let enabled = std::env::var_os("BUN_WASM_INSTALL_TRACE").is_some_and(|value| value != "0");
    ROWS.with(|rows| *rows.borrow_mut() = enabled.then(BTreeMap::new));
}

fn enabled() -> bool {
    ROWS.with(|rows| rows.borrow().is_some())
}

fn record(name: &'static str, time: Duration, bytes: u64) {
    ROWS.with(|rows| {
        let mut rows = rows.borrow_mut();
        let Some(rows) = rows.as_mut() else {
            return;
        };
        let row = rows.entry(name).or_default();
        row.time += time;
        row.count += 1;
        row.bytes += bytes;
    });
}

/// Times `step` under `name` when tracing is on.
pub fn time<T>(name: &'static str, step: impl FnOnce() -> T) -> T {
    if !enabled() {
        return step();
    }
    let start = Instant::now();
    let result = step();
    record(name, start.elapsed(), 0);
    result
}

/// Adds a byte count to `name` without timing anything.
pub fn bytes(name: &'static str, bytes: usize) {
    if enabled() {
        record(name, Duration::ZERO, bytes as u64);
    }
}

/// Prints and clears the collected rows.
pub fn report(total: Duration) {
    let Some(rows) = ROWS.with(|rows| rows.borrow_mut().take()) else {
        return;
    };
    eprintln!("install trace: total {} ms", total.as_millis());
    for (name, row) in rows {
        eprintln!(
            "install trace: {name:<24} {:>8} ms {:>6}x {:>10} KiB",
            row.time.as_millis(),
            row.count,
            row.bytes / 1024
        );
    }
}
