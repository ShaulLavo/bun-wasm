# SpiderMonkey Rust panic reporting

Classification: original adapter.

This repository owns `crates/bunwasm-spidermonkey/src/panic_report.rs` and
`install_rust_hooks` in `src/lib.rs`. No upstream implementation is copied or
patched by this change. The surrounding Mozilla glue comes from the revision
pinned by `spidermonkey/common.sh`.

The Rust panic hook reports a string payload and its file, line, and column
through the existing `bunsm_host_fatal(const char*, size_t)` callback. Both borrowed
string and owned `String` payloads are read without copying into a heap allocation.
Non-string payloads receive a fixed description. The report uses a 1024-byte
stack buffer and formats only borrowed strings and integers. An oversized report
uses a static fallback rather than panicking again while formatting.

The callback consumes the bytes synchronously. The engine adapter writes the
fatal diagnostic to stderr and calls `bun_core_exit(134)`. Standalone smoke
controls exit 134, while the engine semantics controls trap. The module evaluation
query control calls `abort`. Their pointer and length contract is unchanged.

This unit changes reporting only. It does not identify or repair the panic seen
during Nuxt rendering, alter engine tiers, or recover from a panic.
