## Fair loop scheduling

Class **Host feature**, **original adapter** in `src/js/loop_scheduler.ts` and
`bootstrap.js`. No upstream implementation is copied, so there is no upstream
path or revision.

The scheduler gives I/O a turn between callback turns, even when callbacks keep
queuing immediates or timers remain due. Immediate callbacks queued during an
existing batch wait for the next batch, so due timers can run. Like Node's
timers phase, every timer already due when a timer turn starts runs before the
next immediate batch, one callback per turn, even when an earlier timer in that
turn queued an immediate. Timers scheduled or refreshed during the turn are due
later, and an interval is re-armed after its callback from the time it fired,
overriding any `refresh()` or `_idleStart` write made inside the callback, as in
Node's `listOnTimeout`. The phase therefore ends unless a callback deliberately
moves a timer's deadline back to the past by writing `_idleStart` (for example
`t.refresh(); t._idleStart = 0` in a one-shot timer's own callback); Node 26 and
Bun 1.4.4 also keep running such a timer without yielding. Microtasks still
drain between callback turns. Before entering callbacks, the scheduler also drains
pending handled signals and yields to the job queue when a handler ran, at most
once before letting I/O and callbacks progress. This bound prevents a handler
that resends its signal from a microtask from starving callbacks. JSC can
execute the entry module during the job drain, after Rust's initial signal poll;
without this checkpoint a signal received during synchronous sleep ran after the
next immediate. The checkpoint stays outside engine interruption callbacks and
preserves the existing I/O phase. This uses the existing signal and I/O interfaces
and adds no host ABI slot.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`src/js/loop_scheduler.ts` and callback batching](#fair-loop-scheduling) | Host feature | Original portable I/O turns, pending-signal dispatch before check callbacks, bounded immediate batches, and timer phases bounded by the time they start. |

[Ledger scope and pinned revisions](scope.md).
