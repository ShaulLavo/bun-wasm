# Guest Wasm capacity binding

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/engine.rs` | Original adapter | Share the Wasm memory 0 capacity readout between in-guest engines. |
| `crates/bunwasm-engine-{quickjs,hermes,jsc,spidermonkey}/src/vm.rs` | Original adapter | Include `wasmCapacity` in each engine's memory record. |
| `tests/fixtures/process-wasm-capacity/` | Original test adapter | Check the public guest binding, page units, and that RSS reports it. |

No upstream implementation is copied or changed. This binding uses Rust's
`core::arch::wasm32::memory_size` intrinsic. The existing engine heap APIs and
their pinned upstream references remain in [QuickJS memory telemetry](quickjs-memory-telemetry.md),
[Hermes memory telemetry](hermes-memory-telemetry.md),
[JSC memory telemetry](jsc-memory-telemetry.md), and
[SpiderMonkey engine program](spidermonkey-engine-program.md).

## Contract

`process.memoryUsage().wasmCapacity` is the current capacity of the guest's
linear memory in bytes, independently of the engine's heap counters. The
engine and common core share memory 0. Native Rust engine bindings return
`null` because they have no guest linear memory. The engine records keep `rss`
null; `process.memoryUsage().rss` reports this capacity as the guest's resident
memory, and `wasmCapacity` stays a non-enumerable property so the result has
Node's five keys ([Process memory figures](process-memory-report.md)). The
host-engine browser binding is separate and does not report this field, so the
shared runtime declaration remains optional.

The shared helper converts the page count before multiplying by 65,536 so
the 4 GiB wasm32 limit remains representable. The native fixture checks the
JS binding. Rust controls check native `null` and an exact one-page guest
growth through the same helper.

Feature manifests require the capacity, process-field and large-I/O fixtures on
the existing ordinary QuickJS, JSC and SpiderMonkey pairs. The native gate runs
these assertions after its producers and shell registration, with no additional
engine build. The large-I/O assertions run after the capacity prerequisite.
