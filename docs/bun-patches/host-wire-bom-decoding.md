## Host wire BOM decoding

The internal host wire carries string data, not encoded text files. Its UTF-8
reader preserves every leading U+FEFF in values and object keys. A separate
`TextDecoder("utf-8", { ignoreBOM: true })` handles those two reads; the existing
module-source decoder keeps its behavior. Byte payloads still copy out of wasm
memory.

The public runtime `TextDecoder` applies its existing BOM policy after UTF-16LE
decoding as well as UTF-8 decoding. Default decoding removes one leading U+FEFF;
`ignoreBOM: true` preserves it. Windows-1252 and fatal UTF-8 behavior are unchanged.

These are original bun-wasm adapters, not copied or adapted upstream source.
They extract only the decoder changes from PR102 at
`dddc31daca46d7faeb1834d66039b3acb635128c`. No Bun, Node, WebKit or QuickJS source is
changed, so there is no upstream source revision for these edits.

`scripts/engine-host-wire.test.ts` evaluates the actual wire reader/writer and
public codec source with explicit Rust-decoder stand-ins. It covers one and two
BOMs, object keys, native error data, byte copies, Unicode/NUL, view bounds and
fatal UTF-8 errors. It executes no Rust, wasm, browser, application or network
path. Its single blocking discovery owner is `checks/quality-engine-host-wire.json`.
Source tests do not establish current-guest or Next application acceptance.

| Source | Class | Local change |
| --- | --- | --- |
| `web/src/engine-host.js`, wire string/key reads | Host feature | Original internal-data decoder preserves leading U+FEFF. |
| `crates/bunwasm-runtime/src/js/web.js`, `TextDecoder.#decodeBytes` | Host feature | Original public decoder applies the common BOM policy to UTF-16LE. |

[Ledger scope and pinned revisions](scope.md).
