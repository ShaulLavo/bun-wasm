# Host polyfill response serialization

## Classification and source

| Source | Class | Local change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/engine_host.rs` | Host feature | Serialize the selected static polyfill directly into the owned result buffer. |
| `crates/bunwasm-runtime/src/engine_host/polyfill_tests.rs` | Test fixture | Exercise registration, exported dispatch, wire bytes, result ownership and native reentry. |
| `crates/bunwasm-runtime/src/modules.rs` | Test fixture | Select those regressions through the existing host-native quality filter. |

These are original bun-wasm adapters and fixtures. There is no copied upstream
implementation, upstream path or upstream revision. The adapter is based on
bun-wasm `e2647413e`.

## Ownership and dispatch

`modules::polyfill_source` already returns an embedded `&'static str`. The host
records the existing `polyfillSource` registration index without changing its
name, position or owned `DataFn` implementation. Only dispatch at that index
serializes the static string directly into thread-local `RESULT`. Ordinary
`Val::Str` results and this response share the existing string encoder.

The source reference stays within synchronous serialization. `RESULT` owns its
bytes and retains its capacity on reuse. There is no callback during that
serialization and no borrow across ordinary native execution or reentry. The
owned `Val` and `DataFn` contracts, missing-source undefined response, argument
errors, source text and source positions stay unchanged.

The removed allocation copies exactly one complete source per response. For the
measured sources, this is 37,656 bytes for bootstrap and 77,647 bytes for net.
The result allocation and host-side decoding remain. This change does not
establish a fix for native memory constructor rejection, Instance allocation
failure or async startup completion.

## Regression owner

The blocking native quality job already runs runtime tests with
`--no-default-features --features engine-host --lib modules::tests::host_`.
Four tests in that selection call the internal test module. They initialize the
real host registry and consume `bunwasm_alloc` buffers through `bunwasm_call`.
They compare complete responses with the registered owned native, including
errors, and check empty, Unicode and NUL string encoding. No new manifest is
needed for Rust tests in that existing selection. Guest execution remains owned
by normal CI.
