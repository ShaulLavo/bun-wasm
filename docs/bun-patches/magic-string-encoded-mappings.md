# MagicString encoded mappings

Classification: private package adaptation, adapted upstream implementation, and
unmodified upstream test fixtures. The Rust loader adapter is original code.

Upstream is Rich-Harris/magic-string, npm release 0.30.21,
`dist/magic-string.es.mjs`. Its full source SHA-256 is
`d637092a6c7dd947e1b27aef30e97d1a5f59dc39b69ef8f4f0e37e766e4df159`.
The published archive SHA-256 is
`fa49762567dca44e8ccf327f365d250e04c482bf7a4ed0ae7d03659b09ac656f`.
The release metadata has no Git revision. The adapter recognizes only this
source at a path ending in
`/node_modules/magic-string/dist/magic-string.es.mjs`. Other sources and paths,
including CommonJS, remain unchanged. Qualification reads no package metadata.
The existing content-based source cache therefore needs no extra invalidation.

`crates/bunwasm-runtime/src/magic_string_encoded.rs` adds an internal encoded
writer for `generateMap`. It streams VLQ segments instead of retaining the
whole decoded mapping, and writes scalar coordinates for unedited `hires: true`
chunks. `generateDecodedMap` still returns independently owned arrays.
Instance and prototype overrides of that method retain the upstream path.
The decoded-method property is read once, preserving accessor behavior; custom
functions receive the original instance and options.
The public SourceMap constructor, exports and prototype names remain unchanged.
Bundle keeps its original mapping implementation. Maps remain enabled.

The VLQ sign/delta and ASCII buffer implementation follows
@jridgewell/sourcemap-codec 1.6.0, `src/sourcemap-codec.ts`, `src/vlq.ts`, and
`src/strings.ts`, from jridgewell/sourcemaps revision
`94c82a925ca79d5eb193ce45d7f0824a4d91e77d`, directory
`packages/sourcemap-codec`. Its published archive SHA-256 is
`f30a35f6af8c347d01b8ff2f8662272f7d986cf21b916704d86c249a90b97e25`.
Both upstream MIT licenses are retained in `scripts/fixtures/magic-string/`.

The fixtures retain compressed exact original and measured candidate ESM,
the unmodified published MagicString ESM declaration, and the unmodified
published codec ESM. `identities.json` binds these fixture bytes. Candidate ESM
SHA-256 is `0ff3919bd96940bb50b71f040f394432564c67da541c0b9f7d7998cf7eab7af0`.
The production correction reads a custom decoded-map accessor once, matching
upstream. Its exact ESM SHA-256 is
`31b9f7f42a733b1646a344933f167f3825dc58517f83682acbbd65f7e1d83395`.
The API control binds the corrected fixture to that single change in the
measured candidate and checks its getter count, receiver and options.
Native State tests verify ordinary loading, hot preparation, unsupported input,
and source cache invalidation. The ordinary loading test passes its actual
emitted source to the API controls. Those controls compare encoded map bytes,
decoded positions, returned ownership, edits, Unicode, paths and overrides.

The allocation comparison was measured previously on a historical JSC guest.
This source integration does not qualify a changed guest, CommonJS optimization,
a native framework build, or a cause of Safari's allocation refusal.
