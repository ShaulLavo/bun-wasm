## Missing executable errors

Class **Host feature**, original adapters. `crates/bunwasm-runtime/src/js/spawn.ts`
consumes generic negative WASI errno from `runtime_proc` admission. Bun spawn and
spawnSync throw; Node emits error then close without spawn or exit, preserves requested
piped streams, and adds syscall/path/spawnargs. Node spawnSync returns null status
and no output array for failed admission. Arbitrary abort reasons, including null,
remain unchanged. The synchronous rejection tests use the same generic fake service
as the rest of the spawn facade tests.

The former Bun-only `SubprocessHost`, startup supervisor and startup-probe helper
are removed. Waffle owns process launch and worker lifecycle. Both `wait` and `wait_job` consume an eight-byte kind/value result from Waffle
`a0a0f8794cde02410a11be38771b31cdbd3af89a` (`proc/{types,abi,outcome}.ts` and
`proc/worker-{client,abi}.ts`), shared by the root, web and sandbox consumers. START_FAILED
is kind 2 with a positive WASI errno: ENOENT, EACCES, ENOTDIR, ENOEXEC, ENOMEM, EAGAIN
or EIO. Original Rust guest/native bridges and `spawn.ts` preserve this distinction;
real exits 126/127 remain ordinary exits. Native setup failures release their descriptor
snapshot before publishing this result, and invalid output memory never consumes a wait.
The configuration adapter also surfaces typed setup errors instead of empty diagnostics.

Bun asynchronous startup rejects `exited` and calls `onExit` with the error; Bun synchronous
startup throws only after descriptor cleanup. Node reports error/close with code, errno,
path, syscall and spawnargs. Original tests cover all seven failures plus ordinary126/127.
Node's spawn event uses non-consuming generic `start_status` and CHILD_START (poll
kind 6), not child output or terminal completion. A successful observation fires spawn
once and drops the startup subscription; all seven failure-ordering tests are enabled.
A live-child test writes stdin in its spawn listener before any output or completion.
Native entry and terminal selection share one lock, so a canceled launch cannot enter
`_start`. Node WASI validates exports and completes host setup before marking entry.
The Node host imports Waffle's shared `startFailure` normalizer through the public
`waffle/proc` export; the package owns errno normalization rather than a copied local mapping.
These guest, native and Node bridges are original adapters; no upstream implementation
is copied here.

Behavior references at Bun revision `5e0baa66516f3af00b008cdf1521c681317741e8`
are `src/runtime/api/bun/js_bun_spawn_bindings.rs::throw_command_not_found`,
`src/js/node/child_process.ts`, `test/js/node/test/parallel/test-child-process-spawn-error.js`,
`test/js/node/test/parallel/test-child-process-spawnsync.js` and the spawn-failure
close-event tests in `test/js/node/child_process/child_process.test.ts`.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Missing executable errors](#missing-executable-errors) | Host feature | Original Bun/Node and native adapters consume eight-byte typed process/job completions, map seven portable startup errnos, and preserve failed Node streams. |

[Ledger scope and pinned revisions](scope.md).
