## Generated-function parser locations

The generated-function adapter now uses original import-keyword byte positions
from Bun's full parser, then converts them to UTF-16 offsets in each original
constructor argument. It keeps comments, templates, property names, regex literals
and caller strings intact. Native constructors validate the original arguments
before rewriting. A function literal accesses a fixed intrinsic-prototype helper,
so lexical globalThis bindings and with scopes cannot capture the callback.
Specifier conversion occurs once inside an async function and rejects Symbols.
This is original glue, with no package implementation copied.

| File | Classification | Upstream and local changes |
| --- | --- | --- |
| patches/bun/0010-wasm-expose-semantic-dynamic-import-locations-to-the.patch | Upstream patch | Reused unchanged from the semantic-import patch, Bun wasm commit cd95fa7a13b3f13be73e512b38ec111c1c228084. Exposes parser keyword positions and printer metadata. |
| crates/bunwasm-transpiler/src/lib.rs function_imports | Original adapter | Constructs the native function grammar around original argument ranges and translates parser offsets. |

Patch 0010 touches src/js_parser/lib.rs, src/js_parser/parse/parse_import_export.rs
and src/js_printer/lib.rs at upstream Bun revision
9510e74152073d850a18758ca41114d8f214ffa6. The parser collector records only real import
expressions and restores its previous thread-local state on unwind. The printer
metadata is consumed by semantic import linking; this adapter consumes only the
parser collector. The existing shared vendor checkout was read, never edited.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/function.ts`](#generated-function-parser-locations) | Host feature | Original generated-function import adapter using parser positions and an intrinsic helper. |
| [`patches/bun/0010-wasm-expose-semantic-dynamic-import-locations-to-the.patch`](#generated-function-parser-locations) | Port | Bun parser and printer import metadata, reused unchanged from the semantic-import patch. |
