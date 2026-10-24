# 002. Install network functions into the function table instead of importing them

Status: accepted
Date: 2026-10-15

## Context

WASI preview1 has no sockets. A guest that wants `fetch` and `Bun.serve` needs functions from its host. A core wasm module cannot declare optional imports: an unknown import makes `wasmtime run` and `WebAssembly.instantiate` fail. A guest that imports its network functions would refuse to start on every host that lacks them.

iOS Safari adds a second constraint. It traps a `call_indirect` into a function from another module with "signature does not match".

## Decision

The guest does not import the network functions. It exports its function table and `bun_wasm_host_slots()`, which returns an address in linear memory holding an ABI version, a slot count and one table index per function. Before `_start`, the host appends each function it implements to the table and writes the index into its slot. A slot left at 0 means "not provided". A host that cannot use the table writes `0xFFFFFFFF`, and the guest then calls that slot through WASI's `sock_send`, which every preview1 host has.

## Alternatives considered

- **Plain wasm imports.** They break every host that lacks one function, including plain Wasmtime and any host that only wants files. This is the obvious choice and the one that lost.

## Consequences

Hosts opt in per slot, and without networking the APIs report "not supported". The table path needs a small hand-encoded wasm module in the browser, because Safari lacks `WebAssembly.Function`. The `sock_send` path is the default in the playground and sandbox for the iOS case (`?slots=table` selects the table for comparison).

Processes use real imports instead ([ADR 003](003-processes-run-on-the-waffle-process-abi.md)), so a host has two contracts to implement. See the [Host ABI](../host-abi.md).
