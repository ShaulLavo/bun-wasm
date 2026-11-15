# SpiderMonkey Rust panic reporting

Classification: original adapter.

This repository owns `crates/bunwasm-spidermonkey/src/panic_report.rs` and
`install_rust_hooks` in `src/lib.rs`. No upstream implementation is copied or
patched by this change. The surrounding Mozilla glue comes from the revision
pinned by `spidermonkey/common.sh`.
The current pin is `a5df22d986d4b626f771b4f8885241941601c35c`.

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

`scripts/spidermonkey-panic-reporting.test.ts` runs the hook in host subprocesses.
`scripts/spidermonkey-panic-process.test.ts` consumes the normal side build,
engine archive from its link map, selected SpiderMonkey core, and native launcher.
It first runs JavaScript through the production side. It then links a test-only
`--wrap=bunsm_host_call` object to panic at an actual engine callback. Borrowed
strings, owned strings, non-string payloads, and oversized reports must all exit
134 without returning to JavaScript. No injection code enters production sides,
and the control writes no producer receipts. Each test removes its temporary
objects and Wasm programs.

The process control is registered with the runtime owner. Its standalone command
accepts the same producer inputs and an evidence destination:

```sh
source env.sh
bun scripts/spidermonkey-panic-process.ts CORE LAUNCHER SIDE_BUILD ENGINE_ARCHIVE OUTPUT_JSON
```
