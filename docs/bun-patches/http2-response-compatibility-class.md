## HTTP/2 response compatibility class

`crates/bunwasm-runtime/src/js/http2_response.ts` is a **Port** of Bun's
`src/js/node/http2.ts`, specifically `Http2ServerResponse`, response stream event
handlers, header helpers and the compatibility socket proxy. Link-header validation
comes from `src/js/internal/validators.ts`. The upstream revision is
`9510e74152073d850a18758ca41114d8f214ffa6`. The read-only local Bun source at
`d71508d31edf06765c12adf0df137ef531539f68` includes this repository's existing
patch series, including the link-header regex correction. No upstream file changes
in this addition. Bun's MIT notice remains in `crates/bunwasm-runtime/generated/builtins/LICENSE.md`.

The port replaces Bun intrinsics with ordinary JavaScript, uses the existing
Node Stream implementation and validators, and retains headers, trailers, status,
body forwarding, push-response wrapping and finish/close event ordering. HTTP/2
error constructors are local coded errors. WeakMaps replace Bun-private response,
trailer and proxy-socket slots. The response has no request object because this
adapter does not implement `Http2ServerRequest`. Session socket forwarding uses
`session.socket` instead of Bun's private socket slot and native byte counter.
The standalone link validator avoids a missing primordial in the stream bundle's
unused validator copy. These changes let the class run under all guest engines.

The end-callback refinement also ports `Http2ServerResponse.end` from
`src/js/node/http2.ts` at Bun revision
`38afee6c84fcf48c0edb2466aa4b27d287a59c30`, verified against installed native Bun
1.4.4 at that revision. It registers one completion handler on both stream and
response finish, then removes both listeners before invoking the callback. This
completes callbacks when a Writable closes before finish, preserves ordinary
finish ordering and avoids retaining the unused listener. TypeScript captures
the narrowed callback in a local constant. Already-ended streams and repeated
end calls retain their existing native branches. Shorthand callbacks are used
directly, as upstream does, through a type guard that narrows the callable. The
already-ended stream therefore receives the response and the caller's own function,
so it can remove that function by identity, while ordinary paired completion stays
receiverless. This corrects receiver and identity mismatches introduced by this
port, not pre-existing main behavior. The fixture covers all three end overloads,
both finish orders, already-ended callback receivers and removal by identity,
listener cleanup and stream error identity.
No transport implementation or dependency revision changes with this refinement.

The `node:http2` factory registration in `builtins.js` is an **original host
adapter**. It exposes this constructor, not an HTTP/1 alias or a sentinel class.
The existing unsupported `createServer`, `createSecureServer` and `connect`
functions are unchanged. The original `astro-http2-response` fixture compares the
class against native Bun 1.4.4 using a controlled writable stream. It proves the
response-class boundary, not HTTP/2 transport or complete Astro compatibility.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [HTTP/2 response compatibility class](#http2-response-compatibility-class) | Port | Adapt Bun's response class, paired end-completion listeners and link-header validation to the existing Node stream implementation without JSC intrinsics. |
| [HTTP/2 builtin registration](#http2-response-compatibility-class) | Host feature | Original factory registration exposes one shared response constructor through named, default and CommonJS exports. |

The feature-owned `checks/native-astro-http2-response.json` registers the fixture
under the existing blocking native gate. JSC retains its existing embedding gate
and runs this fixture against the single shared JSC guest. The fixture path also
selects that gate. Neither selection adds a build or weakens a receipt check.

[Ledger scope and pinned revisions](scope.md).
