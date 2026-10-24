## Native-host XML and optional hooks

`crates/bunwasm-glue/src/native_host.rs` is an original scalar adapter for the
native XML kernel ABI. Its indexing rules follow
`src/parsers/xml_index.rs` and `src/jsc/bindings/highway_xml.cpp`, and its buffer
contract follows `src/highway/lib.rs`, all at Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`. It retains tag state, encoded
noncharacters and UTF-16 surrogate state across chunks without linking Highway's
C++ SIMD implementation. Tests cover both byte and UTF-16 chunk boundaries.
WASI still selects Bun's existing scalar producer and does not link this module.

The same host-only module returns unsupported from Bun's optional Linux tracing
hooks. The original macro hook in `crates/bunwasm-glue/src/extra.rs` returns
`MacroFailed`, matching the declaration in Bun's `src/js_parser/lib.rs` at that
revision. It does not claim to evaluate JavaScript macros. These hooks make
workspace examples and test binaries link rather than excluding them from the
quality gate. They do not add an upstream patch.

The quality gate runs strict target Clippy for the supported QuickJS and
browser-engine CLI builds for `wasm32-wasip1` with WASI SDK 34.0. It explicitly
selects every authored production dependency and denies warnings without the
build environment's cap. A temporary Clippy-only violation in the actual WASI
POSIX library must fail before its original bytes are restored. This original
wiring does not claim that JSC/tools can build without their generated
WebKit/Yarr prerequisites. The same change removes two unused original graph
facade methods, the now-stable C variadic feature attribute, and two needless
borrows in the browser-engine paths. Shared tool parsing returns its existing
three results as a tuple, so detecting a subcommand does not require retaining
an unread named payload type or a dead-code exemption.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Native-host XML and optional hooks](#native-host-xml-and-optional-hooks) | Host feature | Scalar XML indexing and explicit unsupported trace/macro hooks let the full workspace link on the native host. |
