# Selected message tasks

`immediate_queue.ts` and its erased type adapter are original **Host feature**
code. They provide a linked deque with constant-time ordinary enqueue, selected
front enqueue and removal. Consumed links are released. No packet queue is
copied to track message selection.

The private `realTimers.queueSelectedTask` operation in `bootstrap.js` creates a
normal Immediate with the current async context and empty arguments. It reserves
one slot in an active numeric immediate quota, including zero; a null quota stays
null until its normal snapshot. Queue publication and quota accounting remain
coherent if publication or wake fails. A failed selected entry is made inactive
before the original error propagates, so repeated refusal cannot reserve priority
forever. Ordinary setImmediate and due-timeout order are unchanged.

Only remaining MessagePort steps use the private selected operation. A complete
promise and nextTick checkpoint still runs between messages. The finite selected
batch keeps its order ahead of an already queued BroadcastChannel gate, without
giving newly arriving packets that priority. Synchronous receive from the same
selected queue consumes one positive allowance. Initial delivery, new batches,
local close and terminal notifications remain ordinary tasks.

This extends the original worker adapter in `worker-threads-adapter.md`; no Bun,
Node or WebKit implementation is copied. Comparison is Bun's MessagePort and
event-loop behavior at `9510e74152073d850a18758ca41114d8f214ffa6`.
No native engine, provider or public scheduling API is added.

The source clock dequeues through the production queue at native wake time.
Separate controls execute the real bootstrap timer source with a deterministic
clock for quota, cancellation, publication/wake failure, fairness, context and
receiver behavior. The full unchanged web-worker and closure fixtures cover the
actual worker and async-once paths on locally built guests.
