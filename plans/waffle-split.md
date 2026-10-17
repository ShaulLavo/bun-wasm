# Waffle split

**Status: Approved.** Complete the preparatory bun-wasm change before extracting Waffle and before browser-runtime steps 4c, 4d, 5, 6 and 7b resume.

## Decisions

- Create the public MIT-licensed repository `github.com/ShaulLavo/waffle`, package `waffle`.
- Preserve implementation history, including predecessors from before `runtime/` existed.
- bun-wasm consumes a trusted Git dependency pinned to an exact commit. Neither application uses a floating branch or an npm release.
- bash-web declares Waffle as a peer dependency and accepts `createShell({ runtime })`.
- The application creates one runtime and explicitly passes it to Bun and the shell. Worker bootstraps receive capabilities, not a new root runtime.
- Check in TypeScript source. Generate per-module Node JavaScript during `build`/`prepare`; never track generated output.

## Ownership

Waffle owns `runtime/core`, `runtime/fs`, `runtime/proc`, `runtime/interrupt`, the generic `runtime/browser` services, their generic tests, and their plans, ABI documentation, notices and storage evidence. This includes page-side shared filesystem ownership, filesystem worker bootstrap, terminal descriptor destinations, transport rings and HTTP framing, fetch/handle services, configurable preview routing, worker admission and descriptor transport, process bootstrap/finalization and supervision.

bun-wasm retains `web/src/runner.ts`, Bun's adapter and executor, engine host and engine interruption, engine selection, native slots, module-cache policy, install-cache/trampoline adapters, crypto/native-stream integration, buffer transfer, guest websocket script, legacy subprocess and Worker-channel pipes, editor/templates, downloads, manifests and service-worker registration policy. `runtime/proc/worker-pipes.ts` and `web/src/worker-pipes.ts` are different transports; extraction must not substitute one for the other.

Generic tests must import only the package or package-owned fixtures. Bun interoperability, engine, legacy transport and UI tests stay in bun-wasm. Keep mixed acceptance assertions split by ownership; Waffle's normal tests use original tiny guests and do not build Bun's Rust guests.

## Preparation boundary

1. Separate generic worker protocol/bootstrap, admission, descriptors, finalization and supervisor ownership from Bun policy using injected adapters/executors.
2. Inject fetch into the network helper; leave Bun's install hook in its adapter. Keep pointers, slots and native binding names outside the generic NetHost.
3. Make preview routing/service-worker support configurable. Keep Bun's fixed module-cache scope, websocket injection and registration choices in the application.
4. Move generic sources and tests into `runtime/`. Fix outward test imports and curate explicit package exports; no `internal/*` wildcard.
5. Introduce page-owned runtime composition and have runs borrow it.
6. Add generated Node exports, installed trusted-Git testing, consumer-aware build resolution, installed-package size/provenance accounting and package-resolved source assets.
7. Preserve existing Bun persistence namespaces and worker scope/chunk behavior. Keep behavior and mechanical moves distinguishable in commits.

## Runtime contract

The root API is `createRuntime(options)`. A runtime exposes its borrowed filesystem, program and adapter registration, `processes()` and idempotent `dispose()`.

- Exactly one live owner exists per page, enforced by a stable `Symbol.for` slot across duplicate bundles. This is an ownership guard, not a hidden service locator.
- Claim the slot before initialization and retain it through teardown. Release it only after disposal completes; construction failure releases its own claim.
- One filesystem, identity allocator/buffer, process table and lazy supervisor serve all jobs. Never reset process/job numbering per Bun run.
- Registration remains lazy, works after activation and rejects duplicate names. Unknown adapters fail startup rather than implicitly selecting Bun.
- Programs use the interruption admission rules: instrument source bytes, or require explicit trusted cooperative execution for a compiled module. No unrestricted compiled-module escape hatch.
- Bun engine registrations are immutable and engine-qualified. Concurrent runs must not mutate a shared `bun` alias.
- Closing one run or shell must not dispose the page runtime or kill unrelated jobs. Borrowed capabilities do not convey teardown ownership.
- Disposal rejects new work, publishes outcomes/revocation, reaches filesystem quiescence, stops consumers/workers/relays, closes owned filesystem services last, then releases the guard. Logical exit and `Worker.terminate()` returning do not prove physical cleanup. If a quiescence fence rejects, disposal rejects without physically stopping unsafe consumers, closing their filesystem or releasing the ownership guard; destroying the page is the recovery boundary. Preserve the existing admission/quiescence fences; extraction does not claim the later 4c work is complete.

## Package and tooling

- Before extraction, the local package remains `@bun-wasm/runtime`. Rename to `waffle` during normalization.
- Export TypeScript for Bun/browser and source types; export ignored per-module JavaScript for Node. Browser-worker-only entries are not Node exports.
- `build` emits one module for each source module, preserving class/state identity across exports, and validates Node-safe relative specifiers. `prepare` invokes it.
- A clean trusted commit-pinned Git install must generate the Node outputs with no sibling bun-wasm checkout. Test installed exports, not only links or source paths. Keep `private: true` while npm publication is not intended.
- Preserve existing trusted dependencies when adding `waffle` to both applications.
- The browser builder resolves through the consuming application's installation, respects exports and handles dotted Git-cache paths. Mirror every static/dynamic chunk and map under `__bunwasm/`; classic service workers stay standalone.
- Size checks resolve package entries and classify process/interruption inputs by the installed package's resolved provenance. Core's **7,168-byte gzip hard gate** stays unchanged; other budgets are guides.
- Tests and benchmarks resolve source assets through package resolution, never `new URL(bareSpecifier, import.meta.url)`.
- Suite provenance hashes the installed implementation, emitted Node modules used by hosts, package metadata and consumer lock/pin. Do not remove this gate.
- Install both applications explicitly for sandbox typechecking: shared web source resolution is not standalone sandbox installation. Do not bypass exports with broad physical-path aliases.

## Execution and extraction

### 1. Freeze prerequisites and merge preparation

Verify #44, #48, #51 and #52 are merged. Include the final interruption, SIGPIPE, filesystem writer-lock and startup-outcome contracts in the preparation. Work in an exclusive bun-wasm worktree; independently review facade ownership, packaging and generic/Bun cuts; pass CI and browser/installed-package gates, then merge.

Record the exact final source revision, mount and free space before creating extraction scratch.

### 2. Filter with historical closure

Use explicit owned `--source` and `--target` arguments. Never run a target-only filter command with the shared checkout as the implicit source. Create scratch under `/work/tmp/bun-wasm-waffle-cutover-*` and install teardown before running tests.

The retained path closure must include:

- `runtime/`, renamed to the extracted repository root;
- historical `web/src/wasi.ts`, `web/src/fs.ts`, `web/src/memory-views.js` and `.d.ts` (the filesystem move was a copy, so follow/rename detection alone is insufficient);
- predecessor `web/src/{shared-fs,fs-worker,runtime-terminals,subprocess-broker,subprocess,worker,worker-pipes,preview,preview-protocol,sw}.ts` and `web/src/net/`;
- relevant `web/tests/`, `web/bun.lock`, browser build/size tooling and tests;
- `docs/host-abi.md`, `docs/bun-patches.md`, OPFS benchmark evidence and browser-runtime/split plans;
- CI history required by the generic harnesses.

Refresh this list against the preparation's renames before filtering. Broad mixed paths preserve ancestry, not permission to ship Bun-only code in Waffle. Preserve the filter-repo commit map. Verify WASI history reaches the first browser preview1 shim, MemFS reaches the in-memory filesystem scaffold, and memory views reach the resizable memory-view change.

### 3. Normalize and validate Waffle before publishing

Branch before normalization; remove inherited remotes, Bun-only current-tree files and harnesses. Rename the package, add the explicit MIT license and retain applicable upstream notices. Split the generic process ABI and provenance documentation from Bun's numeric-slot/engine inventory. Move generic plans, tests and OPFS evidence. Use the next patch after the frozen runtime version. `git ls-files dist` must print nothing.

Waffle CI owns:

1. clean install, generated-output build, typecheck and unit tests;
2. clean trusted installed-Git/package exports and no-tracked-output checks;
3. Chromium/Firefox/WebKit process/ABI/interruption acceptance;
4. shared-filesystem, IndexedDB and OPFS acceptance;
5. worker scope/static/dynamic chunk acceptance;
6. standalone layer budgets including the unchanged core gate.

Use queued fleet hosts for substantial work. Record real Safari acceptance on the Mac, or a concrete reason it is deferred. Preserve only small evidence and requested deliverables; remove owned copies, installs, profiles and scratch from actual execution hosts.

Only create/push `ShaulLavo/waffle` once this standalone import is valid and independently reviewed. Do not publish a deliberately broken raw extraction.

### 4. Change bun-wasm consumers

Remove the in-tree runtime and import curated Waffle exports. Pin both application dependencies to `git+https://github.com/ShaulLavo/waffle.git#<exact-reviewed-commit>`, add trust, regenerate locks and patch-bump changed packages.

Retain Bun guest emission/native checks, engine/adapter/network/stream tests, application builds/typechecks, initial-download/classic-SW/worker-scope accounting, editor/template assertions, installed-Waffle provenance, and interruption/SIGPIPE interoperability. Remove sibling-runtime installs and direct generic test commands only after Waffle replacements exist.

Run full consumer acceptance using checksum-verified main-compatible guests: applications, units, installed Node hosts, provenance, size/lazy loading, generic processes, service-worker scopes/chunks at root/nested hosting and direct/controlled workers, all three Bun engines, interruption, SIGPIPE and storage. Do not change guest inputs to make the split pass.

Merge Waffle first and pin its actual merged commit in Bun. Candidate cross-repository gates identify both exact revisions. Verify the consumer PR is merged and main CI passes before resuming deferred runtime work.

### 5. Integrate the shell and resume

bash-web uses the Waffle peer and an exact development Git pin. Test Bun and shell concurrently against the same runtime: shared files/identities, independent run closure and duplicate-owner rejection. Then resume deferred generic lifecycle, job control, networking and thread work in Waffle; Bun guest/adapter work remains here.

## Rollback

If required, revert the consumer squash merge through a reviewed bun-wasm PR that coherently restores runtime, imports, manifests, locks, CI and documentation. Preserve Waffle's public history. Do not force-push it away or introduce old/new runtime compatibility branches.
