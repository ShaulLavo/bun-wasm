## Node timer internals

Class **Host feature**, **original adapter** in `bootstrap.js` and
`timer_promises.ts`. No upstream implementation is copied. The reference
behavior is Node `lib/timers.js` and `lib/internal/timers.js` and Bun
`src/runtime/timer/timer_object_internals.rs` at the Bun pin
`9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun 1.4.4.

Libraries read and write some private-looking `Timeout` and `Immediate` fields,
so the guest exposes them the way Node and Bun do:

- `_destroyed` is a prototype getter. A timer is not destroyed while it is
  scheduled or while its callback runs. A one-shot timeout becomes destroyed
  when its callback returns without re-arming it, and any timer becomes destroyed
  when it is cleared.
- `hasRef()` is false once a timer is destroyed, and an immediate's is false
  while its callback runs, as in Bun.
- `refresh()` re-arms a timeout that already fired, including from inside its
  own callback, but does nothing after `clearTimeout` or `close()`.
- `_idleStart` returns the scheduling time. Writing a finite number moves the
  deadline to `_idleStart + delay` and keeps the timer's order among timers with
  the same deadline (the Next.js `t2._idleStart = t1._idleStart` pattern). Other
  values, and writes to timers that are not scheduled, are stored and change
  nothing.
- `clearTimeout` and `clearInterval` accept a timer id as a string only in the
  form `String(id)` prints: no sign, spaces or leading zeros.
- `setTimeout`, `setInterval` and `setImmediate` carry Node's
  `util.promisify.custom` accessor: enumerable, non-configurable and getter
  only, returning the `node:timers/promises` function of the same name.
- `node:timers/promises` registers its abort listener through the runtime's
  protected abort listener, like Node's `kResistStopPropagation`, so another
  listener's `stopImmediatePropagation()` cannot leave the promise pending.

The timers phase change that the `_idleStart` pattern needs is recorded in
[fair loop scheduling](fair-loop-scheduling.md).

## Classification

| Local source | Class | Provenance and reason |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/bootstrap.js`, `Timeout` and `Immediate` | Host feature | Original `_destroyed`, `_idleStart`, `hasRef`, `refresh` and string id behavior, and the promisify accessors. |
| `crates/bunwasm-runtime/src/js/timer_promises.ts` | Host feature | Original protected abort listener registration. |
| `tests/fixtures/node-timer-internals/`, `checks/native-node-timer-internals.json` | Host feature | Original fixture with native Bun 1.4.4 output, run on QuickJS, JSC and Browser. |

[Ledger scope and pinned revisions](scope.md).
