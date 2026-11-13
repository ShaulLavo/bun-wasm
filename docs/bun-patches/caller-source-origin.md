## Caller source origin

Class **Host feature**. Original bun-wasm adapter for `bun:jsc.callerSourceOrigin`.
The contract is defined by `src/jsc/modules/BunJSCModule.h`, `functionCallerSourceOrigin`,
at Bun revision `4ceda2c2868d3a7703c7737ddd9de7244ec384df`. No upstream implementation is copied.
The native implementation walks JSC call frames. This adapter reads structured frame filenames where the engine provides them.
Text-capturing engines use the existing stack parser. It encodes the calling file as a file URL.
Browser module URL mapping stays in the engine host. Without a caller frame, it returns `null`. Preserve V8 eval creation metadata while formatting call sites. Missing-source user frames remain distinct from native frames. The origin adapter stops at opaque user frames and rejects pseudo filenames such as `<input>` instead of scanning onward to an unrelated module. V8 eval sourceURLs bypass host-frame URL filtering after registered module URLs are resolved. Source-map URLs do not name the calling script. These stack adapters are original implementations.
WebKit's browser engine omits eval source locations even with `sourceURL` directives.
CommonJS uses eval in this host, so its caller origin is `null` there. The adapter stops at
an opaque caller frame instead of reporting a later ES module as the caller. ES modules work
in WebKit, and CommonJS origins work in QuickJS, wasm JSC and the Node host.

SpiderMonkey at revision `a5df22d986d4b626f771b4f8885241941601c35c` reads
the existing native saved-frame adapter rather than parsing stack
text. This preserves filenames containing `@` and stops at an unavailable user frame.
Origin reads ask the adapter to exclude self-hosted frames through
`js::GetFirstSubsumedSavedFrame`; native callbacks such as `Array.map` still report
the calling user script. Exception formatting keeps its existing frame selection.
Its `js/public/SavedFrameAPI.h` exposes source labels and IDs, but no introduction type
or eval creation origin. In `js/src/vm/SavedStacks.cpp`, `SavedStacks::getLocation`
chooses a sourceURL display name when present, otherwise the script filename.
`js/src/vm/JSScript.cpp`, `FormatIntroducedFilename`, builds synthetic filenames as
`{filename} line {lineno} > {introducer}`. Eval and Function constructor kinds use
these labels. The adapter returns `null` at them, even when the filename begins
with `bun-wasm:`, rather than skipping to a different caller or guessing an origin
by stripping the suffix. Ordinary filenames and sourceURLs remain usable. A label
that exactly matches the synthetic grammar is ambiguous through this API and also
returns `null`; a filename such as `/line 13 > eval.mjs` remains meaningful.
These are original adapter changes; no SpiderMonkey implementation is copied.


The caller-origin helper does not format stack positions or fetch source lines on structured-stack engines. Function construction needs a caller filename, not a rendered stack. This avoids repeatedly decoding large one-line compiler bundles during webpack rebuilds. It preserves module URL display names, eval creation metadata, opaque caller boundaries, and the application formatter. V8 builtin callbacks with no filename and no eval origin are skipped even when their isNative flag is false, as in the existing formatter. Opaque eval frames still stop lookup. Error stack formatting itself is unchanged.

The bootstrap formatter maps a CallSite only when both its line and column are numbers.
A missing column keeps the filename and line without inventing a column. A missing line
keeps the filename. Complete positions retain source-map offsets, prepared-source names,
and the host constructor-column adjustment. This is original adapter code, not copied
Bun, Node, or WebKit source.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/caller_origin.ts`, `crates/bunwasm-runtime/src/js/{builtins,bootstrap}.js`, `web/src/engine-host.js`, caller origin](#caller-source-origin) | Host feature | Read caller origins through the existing engine stack parser and preserve incomplete CallSite positions before numeric mapping. Original adapter. |

[Ledger scope and pinned revisions](scope.md).
