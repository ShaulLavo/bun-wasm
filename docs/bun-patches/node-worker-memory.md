# Node-host worker memory

## Classification

| Local source | Classification | Purpose |
| --- | --- | --- |
| `web/scripts/node-worker.ts` and the `node-host.ts` launcher call | Host feature, original adapter | Apply a finite general worker heap and retain host out-of-memory diagnostics. |
| `scripts/node-worker-memory*.ts`, compiler/error fixtures and runtime check manifest | Host feature, original tests | Exercise real Node workers with the installed TypeScript compiler and the actual Next app catalog config. |
| `scripts/app-matrix/product-next.ts` and its catalog test | Host feature, original fixture | Declare Bun's types for static previews that call `Bun.serve`. |
| `web/tests/core-node.test.ts`, suite provenance lists and guest-selector tests | Host feature, original tests | Keep clean-host copies and resumed-suite fingerprints complete after extracting the worker helper. |

No upstream implementation is copied or patched. The tests import the existing
`typescript-api` development dependency and use the maintained Next 15 static app
configuration as compiler input.

## Behavior

The Node fixture host previously capped every worker's old-generation heap at
128 MiB. A locked Next 15.5.6 static build completed Webpack compilation but its
TypeScript-checking child exceeded that heap and exited 126. A native worker
observer captured `ERR_WORKER_OUT_OF_MEMORY` before the guest process exited.

Workers now default to the guest memory maximum (`crates/bunwasm-cli/max-memory.txt`, 1 GiB). Explicit caller resource limits still override
that default. The stack remains at least the host's configured size, preserving
a larger caller stack. These rules apply to every Node-host worker, without
inspecting application paths.

An out-of-memory worker cannot print its own fatal error. The host writes that
original error synchronously to its stderr before the process broker handles the
worker failure. It retains the existing broker outcome and guest descriptor
handling. This also keeps the diagnostic visible when an application immediately
exits on its child's failure.
If the host diagnostic write fails, the same original worker error still reaches
later broker listeners and their cleanup. Only that diagnostic write is isolated.

The runtime check launches actual Node workers. It verifies the effective native
limits and successful TypeScript compilation, then imports the real compiler in
a deliberately constrained worker to verify the original fatal diagnostic.
Deliberate out-of-memory subprocesses disable core dumps. Additional native-worker
controls cover closed host stderr, later listener order, original error identity,
cleanup and ordinary worker failures.
It does not build a guest or change browser-engine memory policy.

The actual build exposed a separate fixture error after the worker survived.
Static Next apps include a Bun preview server in `preview.ts`, which Next also
typechecks. Those fixtures now declare `@types/bun@1.4.3`. The source and the
typecheck remain enabled; dynamic Next fixtures do not gain this dependency.
The preview copies Node's read buffer into an ordinary `Uint8Array` for the web
response body boundary. This supplies an `ArrayBuffer` backing store that the DOM
types accept, rather than the buffer declaration's wider `ArrayBufferLike`.
