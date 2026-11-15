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
| `src/executable-marker.ts`, playground registration and subprocess-broker installation | Original adapter | Shared exclusive marker creation and per-consumer target leases over Waffle 0.0.131 at `5515535c372ea4b7c93bd90ceda3cf4756ef9373`. All production registrations install both the launcher and the private target before guest entry. No Waffle source is changed. |
| `web/scripts/run.ts` private import | Original adapter | Waffle ProcessABI at the same 0.0.131 revision. The CLI has no continuation executor, so the import checks fatal cancellation through `signal(0, 4)` before returning NOTSUP without touching pointers or consuming handled signals. |
| `src/package-start-diagnostic.ts` | Adapted implementation | Waffle `proc/start-errno.ts`, `proc/start-diagnostic.ts` and `proc/intrinsics/host.ts` at the same revision. Restricted to synchronous ProcessError reservations. Preserves bounded cause/stack rendering and UTF-8 truncation without importing unpublished source paths. Typed asynchronous startup diagnostics are already copied by Waffle. |
| `tests/package/fixtures/program-shell.ts` | Adapted implementation | Waffle `tests/fixtures/program-shell.ts` at the same revision, using published entrypoints consistently with the installed consumer. Notice draining is extracted without changing supervision or consuming waits. The fixture records stdout and stderr separately and accepts the spawn cwd/job for installed-guest ownership controls. |
| Package handoff Worker and tests | Original adapter | Tiny caller memory, actual installed runtime/WASI imports, filesystem Worker, ordinary exec, installer and supervisor. No maintained engine or guest producer is run. |
| `web/src/engine-host.js`, its declaration and `bun-executor.ts` transfer wiring | Original adapter | Preserve the exact native exec throw through Browser entry promises to Waffle's existing Worker bootstrap. The existing JavaScript host remains directly importable by Node; recognition stays in the TypeScript binding and executor. |

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

Waffle's public exec import returns ordinary errno failures and throws its terminal
control. The binding remembers the exact thrown value without interpreting its private
class or message. EngineHost stops its loop, performs its existing cleanup, and rejects
that same value to Worker bootstrap. It never reports an ordinary exit for that transfer.
The executor also recognizes Waffle's published exit, signal and observation controls,
and Bun's existing default-signal control. Application errors still enter the guest's
uncaught handler. Cleanup failure rejects with both errors rather than acknowledging a
successful replacement with failed cleanup.

The automatic Web test owner covers synchronous transfer, the actual asynchronous
`package_scripts.run` rejection, ordinary and signaled exits, idle completion and setup
cleanup. Executor tests exercise the actual Worker replacement path with the exact
private native throw. The isolated direct-WASI QuickJS fixtures explicitly supply the
unsupported handoff namespace, matching the maintained native consumer.
The direct executor test obtains its bootstrap, signal cells and replacement
constructor through the package fixture's Waffle installation. Separate root and
Web development installs remain separate; no tagged control object crosses those
module identities. Real consumers keep their existing single-peer bundle contract.
The Web unit job runs for every ready pull request, including a package-fixture-only
edit. `scripts/ci-web-phases.test.ts` checks that routing, the automatic test owner
and the absence of a native producer requirement for this fixture.

Browser guests expose a resizable Wasm buffer. WebIDL's `TextDecoder` rejects a view
of that buffer, so the binding copies the bounded prepared JSON into a fixed byte
array before decoding. This is a BufferSource requirement at the private import,
not an engine change. A real resizable-Wasm fixture covers the same route.

Waffle resolves adapter names after executable admission. One private launcher therefore
belongs to the Runtime, and survives installation disposal until Runtime disposal. It
retains no filesystem client, handle, Worker or Wasm memory. Each public installer, playground registration and subprocess-broker installation acquires
a target lease from the same owner. The final lease release removes the target; reinstall
reuses the launcher. Failed first installation removes the launcher during rollback,
without releasing another consumer's pending or committed lease. Marker creation uses
the same exclusive checked write in every consumer. The broker waits for that preparation
before adopting or launching a process; its failures roll back registrations and permit
a fresh installation. The private marker and parent directory remain after successful
uninstall, as the public installer's executable markers already do.

Owned startup failures select `context.startFailed` before entry; execution failures use
`context.fail`. The immediate handle, synchronous revocation, caught work fence and
distinct cleanup failures retain the reviewed ownership contract. Arbitrary foreign
launch throws still require their own cleanup proof. No extra child controller is added.

Source controls run the real playground and subprocess-broker registration functions,
then perform ordinary exec through `createBunExecutor` into their actual private target.
They verify pre/main/post order, target admission, final exit and no return to the old
caller. Marker-conflict controls check rollback and reinstall; overlapping leases check
that one failed installation or disposal cannot remove another consumer's target.
The CLI control executes `run.ts` with a module importing and calling the handoff with
invalid spans. These controls qualify source wiring, not maintained guest/browser
acceptance. Fresh produced ordinary guests and the exact CLI, installer and page consumers
remain required. Shared groups, roots, preview1, filesystem publications and HANDLE signals
retain the 0.0.131 exclusions. Trusted host registration and imported shared memory belong
to a separate release adoption.
