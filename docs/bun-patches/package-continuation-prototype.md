# Private package continuation prototype

This source component is unenabled. The package entrypoints and `installBunAdapters`
do not import or register it. No guest import, package-script trigger or native binding
uses it. Production package scripts continue through the existing guest loop.

| Local source | Classification | Source and revision |
| --- | --- | --- |
| `src/package-continuation.ts`, `package-continuation-plan.ts` | Original adapter | Private prepared lifecycle plan and cancellation owner. Uses Waffle at `b6ce9c22e4032637814a3985fab934915be02bcc`, released as 0.0.130. No Waffle source is modified. |
| `src/package-continuation-children.ts` | Adapted implementation | Waffle `browser/worker.ts` at the same revision. Supplies a real child transport through its existing WorkerProcessClient, filesystem transfer and pipe registry APIs. |
| `src/package-continuation-io.ts` | Adapted implementation | Waffle `proc/command-stdio.ts` at that same revision. Restricted to a single awaited stderr writer; uses one existing process filesystem client for output, cwd checks and child descriptor transfers. This avoids reconnecting the identity or constructing a broader root. Partial writes, readiness, cancellation, rights, append and shared offsets follow the original implementation. |
| `src/package-continuation-diagnostics.ts` | Adapted implementation | Local `package_scripts.ts`, `spawn.ts` and `inspect.js` at bun-wasm `48f16325f618c8b00f50fa870f5803158fad3a16`; their Bun ancestry is recorded in `package-scripts-through-the-shell.md`. The renderer handles the plain spawn Error's own fields and hidden internal stack, not arbitrary exceptions. |
| `tests/package/package-continuation.test.ts`, `tests/package/fixtures/package-continuation.ts` | Original adapter | Real Waffle runtime, filesystem Worker, executable registry, descriptor transfer and process supervision. Controlled host children supply outcomes and cancellation gates. |

The continuation allocates no WebAssembly memory and launches no Worker. Bash children
still use their ordinary process memory and Worker. The prepared command is passed to
Bash unchanged; the guest remains responsible for rewriting and argument quoting.

The prototype uses pinned Waffle source internals where the release has no package
subpath export. It is not added to the published package file list. A production binding
requires independent implementation review, native precommit fallback, live descriptor
handoff and actual maintained-engine acceptance. Child controllers belong to their
installed launchers; runtime-proc diagnostic retention supplies startup details without
an extra continuation controller. Synchronous reservation errors use the release's
bounded diagnostic encoding.
