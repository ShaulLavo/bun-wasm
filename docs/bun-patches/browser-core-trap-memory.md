# Browser core trap memory observations

| Source | Class | Origin and change |
| --- | --- | --- |
| `src/program-memory.ts`, `web/src/memory-telemetry.ts`, executor and launchers | Original adapter | Preserve core memory limit provenance and publish host facts at a Browser native-call trap through the existing snapshot transport. |
| `web/src/engine-host.js`, `engine-host.d.ts` | Original adapter | Add a synchronous observer at the existing `bunwasm_call` boundary, then rethrow the same error. |
| `scripts/goals-matrix/browser-memory.ts`, `execute.ts` | Original adapter | Save retained Browser trap snapshots in the existing matrix terminal log before page cleanup. |

These extend bun-wasm's original host adapters at `9d57bf630`. No Bun, Node,
WebKit or other upstream implementation is copied. The existing raw engine
loader is JavaScript because unbundled Node host workflows import its source
directly. Its minimal hook calls the TypeScript diagnostic helper. No generated
JavaScript or guest rebuild is needed.

The observer runs only when `bunwasm_call` throws a `WebAssembly.RuntimeError`.
It reads the current core `memory.buffer.byteLength` without calling guest
exports. The existing shared channel and `bun-memory` message retain the same
observation through worker cleanup. Observer failures cannot replace the trap.
Normal native calls allocate no additional diagnostic data and do not publish.

`engineCounters.browserCallTrapCapacityBytes` freezes the trap-time capacity.
`browserCallTrapIndex` identifies the native call. The declared maximum is read
from the compiled core's source and carried with its diagnostic transport as
`browserCoreDeclaredMaximumBytes`. For module-defined memory, the compiled
declaration also establishes `browserCoreFactoryMaximumBytes`. An imported
memory's actual factory maximum is unknown. Missing limits stay null, including
when a caller supplies an unrecorded compiled module. No default wasm32 maximum
is substituted. The top-level `memoryLimitBytes` holds the known factory maximum.

These are observations, not an allocation-failure verdict. The allocator's
growth quantum, usable remaining capacity, fragmentation, browser memory
accounting and refusal reason remain unknown. No guest bytes are dumped.

The goals matrix saves these snapshots on failure and during its existing final
log capture before closing the page. A Browser worker positive control grows a
minimal real Wasm memory and traps through the production host wrapper. It checks
the saved log after normal cleanup. Separate controls preserve the thrown error's
identity and keep unknown and imported-memory limits distinct.
