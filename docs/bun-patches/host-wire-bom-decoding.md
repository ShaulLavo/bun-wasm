## Host wire BOM decoding

The internal host wire carries string data, not encoded text files. Its UTF-8
reader preserves every leading U+FEFF in values and object keys. A separate
`TextDecoder("utf-8", { ignoreBOM: true })` handles those two reads; the existing
module-source decoder keeps its behavior. Byte payloads still copy out of wasm
memory.

The public runtime `TextDecoder` owns BOM removal for UTF-8 and UTF-16LE. Default
decoding removes one initial U+FEFF per decode stream; `ignoreBOM: true` preserves
it. Empty output does not consume the initial-BOM state, and subsequent chunks
preserve U+FEFF as data. A final decode resets that state, including after an
error. Windows-1252 and fatal UTF-8 decoding are unchanged.

Blob and Request/Response text consumers use that public decoder before returning
text or parsing JSON. Bun files inherit Blob's text method rather than bypassing
it, and Bun stream text/JSON helpers use the same decoder. Each consumer removes
only one leading BOM. JSON with a second leading BOM still fails parsing; BOMs
inside JSON strings stay intact. Raw native UTF-8 strings remain unmodified.

These are original bun-wasm adapters, not copied or adapted upstream source.
The initial wire/public decoder extraction came from PR102 at
`dddc31daca46d7faeb1834d66039b3acb635128c`. PR172's consumer policy and streaming
state correction follow its independent source review at
`b4d7d206bd4eb7cb5681a8bcc329ec4326923896`; they are new source, not a claim of exact
historical extraction. No Bun, Node, WebKit or QuickJS source is changed, so there
is no upstream source revision for these edits.

`scripts/engine-host-wire.test.ts` evaluates actual wire reader/writer, codec,
Blob, Request/Response, file and stream-helper source with explicit Rust-decoder
and file-read stand-ins. It retains the original 21 wire/codec controls and adds
consumer text/JSON and streaming-state regressions. It models valid UTF-8 and
complete nonsurrogate UTF-16LE code units, plus the existing UTF-8 error controls.
It does not establish malformed UTF-16 or odd-byte streaming support. Its single
blocking discovery owner is `checks/quality-engine-host-wire.json`. Tests execute
no Rust, wasm, browser, application or network path and do not establish
current-guest or Next application acceptance.

| Source | Class | Local change |
| --- | --- | --- |
| `web/src/engine-host.js`, wire string/key reads | Host feature | Original internal-data decoder preserves leading U+FEFF. |
| `crates/bunwasm-runtime/src/js/web.js`, `TextDecoder` | Host feature | Original public decoder applies the initial BOM policy once per UTF-8/UTF-16LE stream. |
| `crates/bunwasm-runtime/src/js/web.js`, Blob and body text methods | Host feature | Public consumers decode text before returning it or parsing JSON. |
| `crates/bunwasm-runtime/src/js/bun.js`, file and stream text methods | Host feature | Files inherit Blob decoding; stream text/JSON uses the public decoder. |

[Ledger scope and pinned revisions](scope.md).
