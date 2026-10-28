## WHATWG reader lock errors

The generated `crates/bunwasm-runtime/src/js/streams_polyfill.js` is a **Port** of
`web-streams-polyfill@4.2.0`, upstream `dist/ponyfill.mjs`, with SHA-256
`5c36bb87ddfddc29a25420608770e9f26b54bb9233f5b59d56771854bb1bbcf8`.
The relevant source algorithms are
`src/lib/readable-stream/default-reader.ts` and
`src/lib/readable-stream/byob-reader.ts` at that package revision.

`scripts/stream-polyfill-node-hooks.ts` is an **original adapter**, class
**Host feature**. It keeps the existing Node completion hooks and
`ERR_INVALID_STATE` code, and changes the two exclusive-reader lock messages to
`ReadableStream is locked`, matching Bun. The input hash, six completion-hook
sites and two message sites are checked before output is written. Its compiler
API is the declared `typescript-api` alias pinned to TypeScript 6.0.2, not Bun
checkout dependencies. TypeScript 7 remains the typechecker and does not expose
this compiler API. This changes error text, not reader locking, option validation
or read scheduling.
`scripts/vendor-streams.py` regenerates the bundled artifact and retains the
upstream MIT license under `third_party/streams/`.

`scripts/stream-polyfill-node-hooks.ts` also accepts Bun's `type: "direct"`. The type conversion allows
`"direct"` besides `"bytes"`, and the `ReadableStream` constructor's default
controller setup receives the runtime's `direct_stream` source, a zero
high-water mark and unit chunk sizes for that type. Strategy and dictionary
conversion order are unchanged. Each of the three rewrites must apply exactly
once. The generated factory takes the runtime's `internal` to load that module;
see [native-host direct streams](native-direct-stream.md).


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Embedded WHATWG Streams](#whatwg-reader-lock-errors) | Port | Pinned portable streams with Bun reader-lock error text. |
| [Streams AST hooks](#whatwg-reader-lock-errors) | Host feature | Original generator adapter preserves Node completion hooks and error codes. |
| [Streams direct type](#whatwg-reader-lock-errors) | Host feature | Original generator adapter gives `type: "direct"` the runtime's direct source. |

[Ledger scope and pinned revisions](scope.md).
