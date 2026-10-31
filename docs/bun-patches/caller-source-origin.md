## Caller source origin

Class **Host feature**. Original bun-wasm adapter for `bun:jsc.callerSourceOrigin`.
The contract is defined by `src/jsc/modules/BunJSCModule.h`, `functionCallerSourceOrigin`,
at Bun revision `4ceda2c2868d3a7703c7737ddd9de7244ec384df`. No upstream implementation is copied.
The native implementation walks JSC call frames. This adapter uses the existing stack parser
for QuickJS, JSC and browser engines, then encodes the calling file as a file URL.
Browser module URL mapping stays in the engine host. Without a caller frame, it returns `null`. Preserve V8 eval creation metadata while formatting call sites. Missing-source user frames remain distinct from native frames. The origin adapter stops at opaque user frames and rejects pseudo filenames such as `<input>` instead of scanning onward to an unrelated module. V8 eval sourceURLs bypass host-frame URL filtering after registered module URLs are resolved. Source-map URLs do not name the calling script. These stack adapters are original implementations.
WebKit's browser engine omits eval source locations even with `sourceURL` directives.
CommonJS uses eval in this host, so its caller origin is `null` there. The adapter stops at
an opaque caller frame instead of reporting a later ES module as the caller. ES modules work
in WebKit, and CommonJS origins work in QuickJS, wasm JSC and the Node host.


The bootstrap formatter maps a CallSite only when both its line and column are numbers.
A missing column keeps the filename and line without inventing a column. A missing line
keeps the filename. Complete positions retain source-map offsets, prepared-source names,
and the host constructor-column adjustment. This is original adapter code, not copied
Bun, Node, or WebKit source.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/{builtins,bootstrap}.js`, `web/src/engine-host.js`, caller origin](#caller-source-origin) | Host feature | Read caller origins through the existing engine stack parser and preserve incomplete CallSite positions before numeric mapping. Original adapter. |

[Ledger scope and pinned revisions](scope.md).
