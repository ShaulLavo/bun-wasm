# SpiderMonkey virtual filenames

## Original adapters

The Rust engine adapter and C++ JSAPI bridge are original adapters against
Mozilla revision `a5df22d986d4b626f771b4f8885241941601c35c`.
No Mozilla source patch is needed.

Virtual module names can contain NUL. Script evaluation, module private data,
the module cache, host resolve/load replies and import referrers must retain
the complete UTF-8 name. Only `JS::CompileOptions::setFileAndLine` needs a
NUL-terminated diagnostic label.

The bridge encodes NUL as `%00` and percent as `%25` for that label. Other
bytes, including backslashes and Unicode, stay unchanged. Encoding percent
keeps literal `%00` names distinct. Names without either byte use the original
C string without an encoded copy. Script private data and module cache keys
use the original length-delimited name. The SavedFrame reader decodes diagnostic
labels before returning filenames to the runtime's source-map lookup. Raw
SpiderMonkey stack strings and error filenames retain the readable encoded label.

The internal script-evaluation ABI carries the filename length, like module
evaluation already does. Host reply buffers have explicit lengths on release,
so an embedded NUL does not truncate their contents or their allocation size.
