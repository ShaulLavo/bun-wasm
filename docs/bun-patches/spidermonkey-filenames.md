# SpiderMonkey virtual filenames

## Original adapters

The Rust engine adapter and C++ JSAPI bridge are original adapters against
Mozilla revision `a5df22d986d4b626f771b4f8885241941601c35c`.
Telling encoded compiler labels from sourceURL labels needs the Mozilla patch in
the [SavedFrame source kind record](spidermonkey-saved-frame-source-kind.md).

Virtual module names can contain NUL. Script evaluation, module private data,
the module cache, host resolve/load replies and import referrers must retain
the complete UTF-8 name. Only `JS::CompileOptions::setFileAndLine` needs a
NUL-terminated diagnostic label.

The bridge encodes NUL as `%00` and percent as `%25` for that label. Other
bytes, including backslashes and Unicode, stay unchanged. Encoding percent
keeps literal `%00` names distinct. Names without either byte use the original
C string without an encoded copy. Script private data and module cache keys
use the original length-delimited name. The SavedFrame reader decodes a label
only when `JS::GetSavedFrameSourceKind` reports `Filename`, before returning
filenames to the runtime's source-map lookup. A sourceURL label is returned
unchanged, and an ordinary filename without percent is returned as the same
string. Raw SpiderMonkey stack strings and error filenames retain the readable
encoded label.

The inspector exposes its existing structured-frame conversion as `errorFrames`.
It accepts an already captured raw stack, so a custom stack formatter can reuse
decoded native filenames without recursively reading the stack accessor. Native
metadata remains authoritative even for an empty trace; unavailable metadata
falls back to parsing the supplied text.
SpiderMonkey's custom `Error.prepareStackTrace` route uses this conversion for
ordinary Errors and captured holders before constructing mapped CallSites.
Other engines retain their existing frame selection.

Every compiler filename the adapter passes to SpiderMonkey must be a
`DiagnosticFilename` or a plain literal without escapes, percent or NUL, because
eval, Function and Wasm names extend the caller's compiler filename with
percent-free suffixes. `scripts/spidermonkey-filenames.test.ts` keeps a closed
inventory of the adapter's compile entries, filename setters and introduction
setters across `cpp/` sources and headers, with negative controls for each
bypass. It checks today's sources; it does not prove arbitrary C++ data flow.

The internal script-evaluation ABI carries the filename length, like module
evaluation already does. Host reply buffers have explicit lengths on release,
so an embedded NUL does not truncate their contents or their allocation size.
The engine-semantics and loop-dispatch controls pass that length at every script
evaluation call, including the failure reporter and successful getter controls.

## Controls

`scripts/spidermonkey-filenames.test.ts` compiles and runs the standalone C++
filename codec and Rust reply-buffer tests. Its feature-owned quality manifest
keeps those cheap checks blocking. Controls include ordinary, backslash, Unicode,
literal percent escapes, NUL-prefixed, middle-NUL and multiple-NUL names.

The existing SpiderMonkey `engine-semantics` driver also runs
`tests/filename-controls.cpp`. Script and CommonJS compilation retain dynamic
import referrers, SavedFrame filenames and original line numbers. Module controls
retain static and dynamic import referrers and require/import namespace identity
for distinct full IDs. The source-kind controls are listed in their own record.
The `filename` control mode selects this subset locally.

`tests/fixtures/virtual-filenames` exercises the runtime's `node:vm` entry point
and formatted call-site filenames. Its native manifest selects the ordinary
SpiderMonkey producer. These are source controls, not a Nuxt compatibility claim.
`tests/fixtures/spidermonkey-callsite-frames` checks direct, eval and Function
sourceURL text with literal percent escapes and Unicode, lazy formatter identity
and captured holders on the same producer.
