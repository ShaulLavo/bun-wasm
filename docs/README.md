# bun-wasm documentation

Start with [Getting started](getting-started.md). Everything else is one click from here.

## Learn

- [Getting started](getting-started.md): run, test, bundle and serve TypeScript in a browser tab, then run the playground locally.

## Do a task

- [Embed bun-wasm in a page](guides/embed-in-a-page.md): register Bun on a Waffle `Runtime` that your page owns.
- [Troubleshooting](troubleshooting.md): symptom, cause and fix for the common failures.
- [Development](development.md): build the guests, run the tests, change Bun's source.

## Understand

- [Architecture](concepts/architecture.md): the layers, the three engines, the host interface.
- [Decision records](adr/001-three-engines-behind-one-runtime.md): why the code has its shape. [001 engines](adr/001-three-engines-behind-one-runtime.md), [002 host slots](adr/002-host-functions-installed-in-the-function-table.md), [003 processes](adr/003-processes-run-on-the-waffle-process-abi.md), [004 guest artifacts](adr/004-guests-live-outside-the-package.md), [005 patching Bun](adr/005-patch-bun-minimally-and-keep-a-ledger.md).

## Look up

Status and measurements:

- [Compatibility](compatibility.md): commands, engines, real apps, Bun's test suite.
- [Limits](limits.md): memory, stack, threads, processes, network, filesystem, browsers.

Interfaces:

- [Host ABI](host-abi.md): the `bun_wasm` network slots and the `runtime_proc` process imports.
- [Browser package](browser-package.md): exports, ownership, integrity, acceptance gates.
- [The browser engine](engine-browser.md): the host-engine guest and how it differs.
- [Playground](playground.md), [Sandbox](sandbox.md), [Browser storage modes](storage-modes.md).

Runtime behavior:

- [Installing npm packages](install.md), [Foreign lockfile migration](lockfile-migration.md)
- [TCP on the host ABI](tcp.md), [HTTP response and upgrade compatibility](http-compatibility.md), [The ws builtin](ws-builtin.md)
- [Worker threads](worker-threads.md), [Bun processes on a caller-owned network](runtime-network-consumer.md)
- [Crypto APIs](crypto.md), [Data parsers and glob](parsers-glob.md), [Bun JavaScript builtins](bun-builtins.md)
- [Stack overflow in wasm](stack-limits.md), [Wasm memory views](memory-views.md)

Provenance:

- [Changes to Bun and other upstream source](bun-patches.md): the ledger of every patch, copied file and adaptation.

## Contribute

- [Code quality](code-quality.md), [Browser gate coverage](browser-gates.md), [Browser command deadlines](browser-deadlines.md)
- [JavaScriptCore for wasm32-wasip1](jsc-build.md), [A portable backend for Bun's Rust host functions](bun-jsc-backend.md), [Runtime TypeScript](runtime-typescript.md)
- [Guest build receipts](guest-build-receipts.md), [Guest artifact publishing](guest-publishing.md)
- [Installer fixtures](install-fixtures.md), [esbuild package checks](esbuild-checks.md), [Next routes to five frameworks](framework-routes.md)

## Measurement records

Tool-owned data, not hand-written pages. Scripts hard-code these paths.

- [`app-matrix/`](app-matrix/README.md): real-app compatibility runs.
- [`bun-test-suite/`](bun-test-suite/README.md): Bun's upstream tests against each engine.
- `bun-jsc-inventory.json`: the API inventory read by `scripts/test-bun-jsc-backend.sh`.
