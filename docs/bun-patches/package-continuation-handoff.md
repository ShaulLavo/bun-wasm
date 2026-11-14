# Private package continuation handoff

This adapter installs a private target and executor import. `package_scripts.run` tries
the prepared handoff before any announcement or lifecycle mutation. Only precommit
NOTSUP or NOSYS retains the existing loop. Framework and physical memory acceptance
remain separate from this source behavior.

| Local source | Classification | Source and revision |
| --- | --- | --- |
| `src/package-continuation-binding.ts`, `package-continuation-installation.ts`, the installer and executor hooks | Original adapter | Waffle WorkerExecutor, DescriptorTable and ordinary exec contracts at `b6ce9c22e4032637814a3985fab934915be02bcc`, released as 0.0.130. No Waffle source is changed. |
| `crates/bunwasm-runtime/src/host.rs` private handoff and `natives.rs` registration; `crates/bunwasm-host/src/slots.rs` unsupported import | Original adapter | Private Bun prepared-plan bridge over the same released exec contract. Native cancellation precedes NOTSUP and pointer access. |
| `package_scripts.ts` `continuationPlan` and trigger; `package_scripts_types.d.ts` | Original adapter | Snapshots the actual guest environment and existing Bun-derived rewrite/quoting functions recorded in `package-scripts-through-the-shell.md`. Successful exec never returns. Any return other than precommit NOTSUP/NOSYS throws before entering the old loop. The feature-owned declaration describes this native result without changing shared declarations. |
| `src/package-start-diagnostic.ts` | Adapted implementation | Waffle `proc/start-errno.ts`, `proc/start-diagnostic.ts` and `proc/intrinsics/host.ts` at the same revision. Restricted to synchronous ProcessError reservations. Preserves bounded cause/stack rendering and UTF-8 truncation without importing unpublished source paths. Typed asynchronous startup diagnostics are already copied by Waffle. |
| `tests/package/fixtures/program-shell.ts` | Adapted implementation | Waffle `tests/fixtures/program-shell.ts` at the same revision, using published entrypoints consistently with the installed consumer. Notice draining is extracted without changing supervision or consuming waits. The fixture records stdout and stderr separately and accepts the spawn cwd/job for installed-guest ownership controls. |
| Package handoff Worker and tests | Original adapter | Tiny caller memory, actual installed runtime/WASI imports, filesystem Worker, ordinary exec, installer and supervisor. No maintained engine or guest producer is run. |

The executor captures the original root Descriptor after inherited bindings, checking
the finite inherited fd set before the default occupied prefix. A root restored by an
earlier exec remains discoverable beyond a gap without scanning sparse fd space. Successful
table close and renumber operations track its identity, including calls through every
WASI import namespace. A fresh census includes live inheritable descriptors plus that
still-live root at its current rights. A root alias cannot restore a closed preopen.

The maintained Node Browser fixture host also provides the private namespace. It uses
the existing process cancellation guard before returning NOTSUP without reading memory.
This permits new guests to instantiate; native shell resolution remains a separate
consumer requirement and is not supplied by this unsupported binding.
Serialization and standard exec transfer run synchronously on the caller's stack.
Each Bash child receives only explicit stdio, while the continuation retains the census.

Browser guests expose a resizable Wasm buffer. WebIDL's `TextDecoder` rejects a view
of that buffer, so the binding copies the bounded prepared JSON into a fixed byte
array before decoding. This is a BufferSource requirement at the private import,
not an engine change. A real resizable-Wasm fixture covers the same route.

Waffle resolves adapter names after executable admission. One private launcher therefore
belongs to the Runtime, and survives installation disposal until Runtime disposal. It
retains no filesystem client, handle, Worker or Wasm memory. Uninstall removes its program;
reinstall reuses the launcher. Failed first installation removes it during rollback.

Owned startup failures select `context.startFailed` before entry; execution failures use
`context.fail`. The immediate handle, synchronous revocation, caught work fence and
distinct cleanup failures retain the reviewed ownership contract. Arbitrary foreign
launch throws still require their own cleanup proof. No extra child controller is added.
