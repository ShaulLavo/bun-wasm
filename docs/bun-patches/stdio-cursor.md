## Standard-output cursor methods

`crates/bunwasm-runtime/src/js/process.ts` adds `clearLine`, `clearScreenDown`,
`cursorTo` and `moveCursor` to the existing stdout and stderr writers. This is
original bun-wasm API glue extracted from the stdio-only portion of held draft
PR #102 at `58ca4cd24de28aba03a94a3babb4a49e8cd707c7`. That PR has no submitted
review; extraction does not accept its other changes or its obsolete source probe.

The reference contracts are Node v26.12.1 `lib/tty.js` and
`lib/internal/readline/callbacks.js`, inspected through the local Node binary's
embedded sources, and local Bun 1.4.4 terminal methods. No upstream implementation
is copied or patched. ANSI bytes, argument errors, callback forwarding and return
values belong to this Bun/Node adapter. Waffle still owns TTY discovery, process
execution and file descriptors. No host operation is added.

Each method calls its receiver's existing `write` and returns that boolean,
including false. Writes keep their callback identity and existing deferred success
or failure timing. Zero movement schedules a callback with `internal.nextTick`
without writing. The callback is validated before resolving `cursorTo`'s second
argument overload, so an invalid third argument is not silently ignored.
Writer construction, lazy stdio getters, input reads, headers and TTY flags are
unchanged. These methods are available on both existing writers, including pipes;
this does not claim that native Bun exposes them on redirected stdout.

`scripts/stdio-cursor.test.ts` loads the actual factory through the production
TypeScript-erasure script and uses fake native writers. It covers bytes on both
file descriptors, true/false TTY flags, borrowed receivers, boolean return values,
callback identity, deferred callbacks, write failures, zero movement, argument
errors and declarations. The shared narrow contract also runs against Node's real
`tty.WriteStream`. `checks/runtime-stdio-cursor.json` assigns this test to the
existing blocking runtime owner and local-runtime selection. The existing process
AST guard removes only the added cursor declarations and properties before checking
the unchanged original hash; its behavioral comparison permits only those four
new own keys on each writer.

The observed consumer is Vite 7.1.12 `dist/node/chunks/config.js`, lines 33852-33855.
Its production-build cleanup calls `process.stdout.clearLine(0)` then `cursorTo(0)`
when stdout is a TTY and CI is unset. Both vanilla and React browser baselines stop
at the first call. This change supplies those calls without bypassing their guard.
Factory tests are not a passing Vite build claim. The parent owns post-merge matrix
reruns; other framework benefits remain hypotheses.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Standard-output cursor methods](#standard-output-cursor-methods) | Host feature | Original Bun/Node cursor API adapter and focused factory/reference controls. No upstream code or OS operation added. |

[Ledger scope and pinned revisions](scope.md).
