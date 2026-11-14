# Private package continuation handoff

This unit installs a private target and executor import. `package_scripts.run` still
uses its existing loop. No engine, browser, framework or memory benefit is established.

| Local source | Classification | Source and revision |
| --- | --- | --- |
| `src/package-continuation-binding.ts`, `package-continuation-installation.ts`, the installer and executor hooks | Original adapter | Waffle WorkerExecutor, DescriptorTable and ordinary exec contracts at `b6ce9c22e4032637814a3985fab934915be02bcc`, released as 0.0.130. No Waffle source is changed. |
| `crates/bunwasm-runtime/src/host.rs` private handoff and `natives.rs` registration; `crates/bunwasm-host/src/slots.rs` unsupported import | Original adapter | Private Bun prepared-plan bridge over the same released exec contract. Native cancellation precedes NOTSUP and pointer access. The guest trigger is unenabled. |
| `package_scripts.ts` `continuationPlan` | Original adapter | Snapshots the actual guest environment and existing Bun-derived rewrite/quoting functions recorded in `package-scripts-through-the-shell.md`. It is not called by `run`. |
| `src/package-start-diagnostic.ts` | Adapted implementation | Waffle `proc/start-errno.ts`, `proc/start-diagnostic.ts` and `proc/intrinsics/host.ts` at the same revision. Restricted to synchronous ProcessError reservations. Preserves bounded cause/stack rendering and UTF-8 truncation without importing unpublished source paths. Typed asynchronous startup diagnostics are already copied by Waffle. |
| `tests/package/fixtures/program-shell.ts` | Adapted implementation | Waffle `tests/fixtures/program-shell.ts` at the same revision, using published entrypoints consistently with the installed consumer. Notice draining is extracted without changing supervision or consuming waits. |
| Package handoff Worker and tests | Original adapter | Tiny caller memory, actual installed runtime/WASI imports, filesystem Worker, ordinary exec, installer and supervisor. No maintained engine or guest producer is run. |

The executor captures the original root Descriptor after inherited bindings. Successful
table close and renumber operations track its identity, including calls through every
WASI import namespace. A fresh census includes live inheritable descriptors plus that
still-live root at its current rights. A root alias cannot restore a closed preopen.
Serialization and standard exec transfer run synchronously on the caller's stack.
Each Bash child receives only explicit stdio, while the continuation retains the census.

Waffle resolves adapter names after executable admission. One private launcher therefore
belongs to the Runtime, and survives installation disposal until Runtime disposal. It
retains no filesystem client, handle, Worker or Wasm memory. Uninstall removes its program;
reinstall reuses the launcher. Failed first installation removes it during rollback.

Owned startup failures select `context.startFailed` before entry; execution failures use
`context.fail`. The immediate handle, synchronous revocation, caught work fence and
distinct cleanup failures retain the reviewed ownership contract. Arbitrary foreign
launch throws still require their own cleanup proof. No extra child controller is added.
