<a id="web-worker-adapter"></a>

## Global Web Worker adapter

Class **Host feature**, original adapters. `crates/bunwasm-runtime/src/js/web_worker.ts`
implements the global `Worker` constructor and the worker-global message API.
Its Web boundary converts transfer sequences before validating transferable objects,
duplicates, detached buffers, marked objects and WebAssembly memory. Callable
iterables and callable options bags participate in WebIDL object conversion. Rejections
match host Bun 1.4.2 error classes and messages before serialization or detachment.
The host engine exposes the existing memory-buffer classifier from the original
TypeScript adapter in `web/src/buffer-transfer.ts` for this boundary check.
It wraps the separate-guest execution, clone, port, reference and termination
contracts in `worker_threads.ts`. Port packets retain transferred ports for
web events while Node listeners and synchronous receives still return the data. `web.js` installs the constructor and blob URL
entry points. `web/src/worker.ts` captures the physical browser worker sender
before the guest installs its own `postMessage`. After the Waffle layout split,
the Bun worker passes captured host messaging and event methods into the generic
bootstrap, so guest globals cannot replace the physical worker transport. The original `workerSource`
data native calls Bun's Rust transpiler for blob entries, including TypeScript
File names. The shared worker initializer installs worker globals and sets `Bun.isMainThread` to false. Web entries import preloads before the requested module.

The original adapter in `crates/bunwasm-runtime/src/modules.rs` marks entry-body
startup through an import-meta hook.
The TypeScript worker initializer opens its incoming port at the next microtask,
after synchronous entry code installs handlers. Eval entries mark startup after
their generated preloads. This prevents delivery during asynchronous module
loading and still permits message handling during top-level await.

The reference contracts are Bun's `src/js/node/worker_threads.ts` and
`src/jsc/bindings/webcore/Worker.cpp` at the pinned revision in this ledger's opening
paragraph. Their implementation depends on JavaScriptCore native bindings and
cannot run through our portable builtin loader. This adapter copies no upstream
implementation. It adds no host ABI slots and leaves browser module serving
unchanged.

`tests/fixtures/web-worker` exercises URL entry points, options, transfer lists,
worker-global events, preload, errors, natural close, termination and nested
workers. `web/tests/browser-web-workers.ts` runs the same fixture in Chromium and
WebKit on every engine. Cross-guest shared memory remains unsupported by the
existing transport. Object URLs are local to their creating guest and their
contents are captured when constructing a worker.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Global Web Worker adapter](#web-worker-adapter) | Host feature | Original TypeScript EventTarget and worker-global adapters over the existing thread transport. |

[Ledger scope and pinned revisions](scope.md).
