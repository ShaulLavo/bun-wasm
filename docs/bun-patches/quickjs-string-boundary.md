### QuickJS string boundary

Class **Host feature**. Original adapter using QuickJS-ng through rquickjs-sys 0.13.0.
Retain the valid UTF-8 fast path. If QuickJS returns a string containing lone UTF-16
surrogates, read its UTF-16 units through `JS_ToCStringLenUTF16`, replace unpaired units
with Rust's `String::from_utf16_lossy` and release the QuickJS buffer. This prevents
native UTF-8 consumers from receiving `undefined` for a valid JavaScript string.
No upstream implementation is copied or modified.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/engine_quickjs.rs`, string boundary](#quickjs-string-boundary) | Host feature | Decode lone UTF-16 surrogates as replacement characters at the native boundary. Original adapter. |

[Parent context](bun-patch-series.md).
