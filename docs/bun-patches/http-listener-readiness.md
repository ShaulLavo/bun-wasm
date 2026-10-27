## HTTP listener readiness

Class **Host feature**, **original adapter** in `src/js/net_listener.ts` and the
`http.Server.listen`, `ref` and `unref` integration in `src/js/net.js`.
No upstream code is copied. Bun's `test/js/bun/test/test-timers.test.ts` at
`9510e74152073d850a18758ca41114d8f214ffa6` supplies the occupied-port behavior.

The HTTP startup waiter polls the existing `hostLocalAddr` contract instead of
publishing `listening` before the host has bound its socket. A pending bind keeps
the waiter alive. Success emits `listening` before registering the accept waiter,
so a queued connection cannot overtake the listen callback. Closing in that
callback prevents acceptance, and its `ref`/`unref` choice applies to the new
accept waiter. Each startup owns a distinct waiter identity, checked before
polling and after invoking listeners. Closing and re-listening inside the callback
cannot let the previous startup install an accept waiter for the new listener.
An announcing startup does not announce again during a nested I/O pump.
Failure releases the handle and emits the original host error
without starting acceptance. Closing cancels startup. `ref`/`unref` control acceptance; an in-flight bind
request remains referenced until its completion or cancellation. The Node host's synchronous
port probe is not proof that its later named-host bind succeeded. No delay or
retry is used, and fake timers do not control the I/O waiter.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [HTTP listener readiness](#http-listener-readiness) | Host feature | Original typed startup waiter reports HTTP listener success or bind errors after the host finishes binding. |

[Ledger scope and pinned revisions](scope.md).

## Unreferenced port probes

Class **Host feature**, **original adapter** in `src/js/node_net.js`,
`src/js/net_listener.ts` and the HTTP server integration in `src/js/net.js`.
No upstream implementation is copied. Native Node26.12.1 and Bun1.4.4 controls
complete the `createServer().unref().listen(..., callback)` sequence used by
`get-port-please@3.2.0`, `dist/index.mjs:197-210`.

A bind request owns its own reference until it reports success or error. The
future accepting listener still follows the server's reference state, including
`unref()` calls made before or during binding. This prevents the browser guest
from exiting before the port probe's listen/close callbacks, which blocked the
unchanged Nuxt CLI before it reached its default child-process fork. Closing
still cancels the pending request. No timer, retry or forced permanent listener
reference is introduced.
