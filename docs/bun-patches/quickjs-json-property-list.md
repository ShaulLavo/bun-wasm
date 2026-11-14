# QuickJS JSON replacer property list

Class **Upstream bug**. The adapted function is `JS_JSONStringify` in
`third_party/rquickjs-sys/quickjs/quickjs.c`, from QuickJS-ng 0.16.2 bundled by
rquickjs-sys 0.13.0. This follows the separate JSON ancestor bookkeeping fix.

The private property list uses ordinary indexed assignment upstream and ignores
its result. An inherited index setter can intercept the key, while a getter-only
or nonwritable index can reject it. A dense public replacer such as `["a"]` can
then omit `a` from the output or leave an exception pending.

The local append defines an own configurable, writable, enumerable data property
using `JS_DefinePropertyValueInt64` and checks its result. This operation consumes
the converted key on success and failure, including failed atom conversion.
Failure follows the existing exception path, which frees the property list and
all its previous keys. No second free of the consumed key is needed.
Successful definitions update array length and keep entries contiguous and rooted
for GC, so deduplication and traversal continue to read own entries.

Public replacer reads, including inherited getters for sparse replacers, stay on
`JS_GetPropertyInt64`. Key conversion, order, deduplication, value traversal,
toJSON, cycle checks, reentry and thrown values keep their existing paths.

Original adapters: `tests/fixtures/json-property-list/index.ts` and its
`checks/native-json-property-list.json` manifest cover private hooks, public
controls, conversion, order, deduplication, exceptions, cycles and reentry.
The QuickJS engine's native JSON tests run this fixture directly and exercise
GC and allocation refusal followed by recovery with an array replacer.
