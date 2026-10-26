### Native browser stream completion

Class **Host feature**, original bun-wasm completion bridge with a WHATWG
iterable-conversion adapter. No upstream implementation source was copied into
`web/src/native-stream-state.ts`. Chromium and WebKit lack
Node's private closed-promise and controller-error symbols. The host installs
those hooks before the runtime bootstrap; Node-host execution retains Node's
existing hooks and embedded engines retain the reference ponyfill hooks. Detection
checks both the prototype and a closed native stream instance: Node 24/25 assign
own symbol properties in their constructors, while Node 26 exposes prototype
getters. Native instance hooks receive writable prototype capability slots for
the guest bindings' startup check; constructor assignments still create the real
own properties. Installing a getter-only bridge over the former would break
subsequent native construction. The isolated native-stream probes cover both representations
and a host without hooks, even when the test runner itself uses Node 26.

Construction proxies delegate to the browser's native ReadableStream,
WritableStream and TransformStream constructors and capture their controllers.
Native prototypes, instance brands, byte/BYOB queues and algorithms stay native.
The global constructor references change. Frozen underlying dictionaries are
wrapped without mutation, and callbacks retain their original receiver.

The host bridge also provides `ReadableStream.from` through its tracked native
constructor on every browser host, without native-method or version detection.
This is an original adapter of the WHATWG Streams
[`ReadableStreamFromIterable`](https://streams.spec.whatwg.org/#readable-stream-from-iterable)
algorithm and WebIDL async-sequence opening, next-value and closing algorithms,
read October 20, 2026. It uses high-water mark zero, async-first iterator
acquisition, and ECMAScript async-from-sync conversion. Current WebIDL promise
reactions resolve yielded values after async-from-sync has resolved sync values.
These are separate steps: a second-access then-getter failure rejects the read
without invoking IteratorClose. The static operation is enumerable under WebIDL
§3.7.7. The real-browser controls cover changing then getters, rejection identity
and return-call counts. Cancellation calls the iterator's return with the original
reason, while late next results never enqueue or close an
already-cancelled native stream. Native brands, reader ownership and completion
registration stay with the construction bridge. The real Chromium/WebKit
interop gate includes conversion, malformed results, error identities and
pending-next cancellation controls. The HTTP disconnect iterator fixture is
unchanged.

Completion comes from actual native reader/writer `closed` promises. Temporary
probes release locks immediately without reading or writing. Releasing a pending
closed promise rejects it in place; releasing a terminal promise replaces it.
That identity change distinguishes terminal observation from release errors.
Notifications from controllers and underlying callbacks trigger another probe.
Pending sink abort promises delay completion. Internally acquired native locks,
such as async iterators and pipeTo, use weak polling with host timers. Session
exit stops the timers. No private stream state or promise status is invented.

Streams created outside the construction bridge, including saved original
constructors and opaque native factory outputs, support completion observation.
Their controllers are unavailable through browser APIs, so the error hook cannot
provide Node-style error injection for those opaque readables. The bridge raises
an explicit error rather than treating cancellation as an errored stream.

`scripts/test-native-stream-interop.mjs` executes the exact runtime stream modules
and this host bridge in Chromium and WebKit. Its minimal process/async-context
boundary is a direct-module test, not a wasm-build claim. The same fixture also
runs through the actual built browser engine in `web/tests/browser-engine.mjs`.
CI runs the direct native-browser proof so Node-host symbols cannot mask a gap.

The copied Node stream licenses retain their text with whitespace-only normalization
of blank EOF lines and one mixed space/tab indent.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`web/src/native-stream-state.ts`](#native-browser-stream-completion) | Host feature | Original native completion bridge and WHATWG iterable conversion adapter preserve native construction and cancellation. |

[Native-host direct streams](native-direct-stream.md) records the original
Bun-controller adapter used by the construction bridge.

[Parent context](http-framing.md).

[Ledger scope and pinned revisions](scope.md).
