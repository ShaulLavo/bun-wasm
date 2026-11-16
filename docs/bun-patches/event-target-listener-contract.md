# EventTarget listener access and protected aborts

The EventTarget and AbortSignal changes in `crates/bunwasm-runtime/src/js/web.js`
are an original **Host feature** adapter. Comparison sources are Bun
`src/jsc/bindings/webcore/EventTarget.{cpp,h}`, `AbortSignal.{cpp,h}` and
`src/js/node/events.ts` at `9510e74152073d850a18758ca41114d8f214ffa6`.
No upstream C++ implementation is copied into the guest.

The shared web implementation owns listener entries and private brands. An
internal factory contract supplies fresh snapshots of original listener
identities and protected abort registration to the Node events adapter. Public
listener options and symbols cannot grant protected dispatch. Ordinary
listeners still stop after `stopImmediatePropagation`; live protected abort
hooks continue in registration order. Removed entries are skipped during an
active dispatch, and once entries are removed before invoking their callbacks.
Signal registration disposers are detached when the owning listener is removed
or fires. Listener errors retain their original value through the existing tick
reporter.

`events.ts` continues the **Port** described in `node-event-emitter.md`.
Its standard introspection functions use the private table for genuine targets,
and its async helpers use protected registration for genuine signals. Public
duck signals retain ordinary registration. No provider ABI or public API is
added. `events-types.d.ts` is an original erased contract; EventTarget snapshots
include listener objects as well as callable listeners.

The feature-owned source check executes the actual web/events factories together.
The guest fixture checks original identity, receiver, duplicate/capture rules,
live removal, reentrant once callbacks, stopped aborts, disposal, signal cleanup,
brands and Bun's event-name/options conversion order. Native Bun is the behavior
oracle. Node is a comparison oracle where its behavior agrees. The unchanged
upstream events file supplies the four original semantic regressions.
