# 003. Run Bun processes on Waffle's process ABI

Status: accepted
Date: 2026-10-18

## Context

`Bun.spawn`, `node:child_process` and `node:worker_threads` need a process model. Before this decision bun-wasm had its own spawn slots and a controller in `web/`. A browser has no fork and no native executables, and a guest blocked inside synchronous wasm cannot receive `MessagePort` events but can always `poll` a descriptor.

A shell and other WASI programs need to start processes on the same page, and a Bun child should be a peer of those programs.

## Decision

The Bun guest imports Waffle's generic `runtime_proc` process ABI (`spawn`, `pipe`, `read`, `write`, `wait`, `kill`, `poll`, `signal`, plus `fd_close`) as real wasm imports. Each process gets its own worker, and a supervisor in the page keeps spawn, kill and Ctrl-C working against CPU-bound guests. `spawn` starts only executables that the host registered, such as `/bin/bun`. The package registers them with `installBunAdapters`.

The old Bun-specific child slots and the signal slot were removed from the `bun_wasm` ABI.

## Alternatives considered

- **Keep a Bun-specific spawn ABI.** It leaves two process models on one page, so a shell and a Bun child cannot share pipes, jobs or signals.
- **A Unix `fork`.** Bun, shells and Node all spawn. `child_process.fork()` is spawn plus a message channel, which pipes bound to a child descriptor provide. A program that needs a real `fork` stays out of scope.
- **WASIX.** Programs speak WASI preview1 plus these extensions, and the services underneath stay free of any guest ABI. Another contract can be added later as an adapter.

## Consequences

A plain `wasmtime run dist/bun.wasm` fails to link, because the namespace is a hard requirement. The native launcher exists to provide it. Every host that instantiates the guest must implement the imports, with no fallback for an older host.

The page needs cross-origin isolation, because the supervisor and the guests share process state through shared memory. Bun processes can interoperate with a Waffle shell, and the package tests check that composition. See the [Host ABI](../host-abi.md#process-imports).
