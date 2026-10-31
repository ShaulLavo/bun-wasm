# Bun WASI builtin

The runtime exposes Bun's existing `node:wasi` implementation through the builtin
loader. WASI modules can call the filesystem and other process adapters already
available to the runtime. The source control runs actual WASM imports on Bun's
native host WebAssembly with native filesystem calls. This is a standalone WASI
capability, not Nuxt acceptance or shared-memory support in the Wasmi interpreter.

## Source and changes

| Source | Class | Local change |
| --- | --- | --- |
| Bun `src/js/node/wasi.ts` | Patch and port | Include the generated factory as module 188; add reactor initialization and a shared one-time startup guard. |
| Builtin registration, constants hook, and selection policy | Original adapter | Route `node:wasi` to the factory, supply existing filesystem constants lazily, and retain existing adapters for unselected public dependencies. |

The source comes from pinned Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`, with the checked-in Bun patch series.
`0015-node-wasi-initialize-reactor-instances-with-exported.patch` adds
`WASI.initialize(instance)`. It binds exported memory before calling an optional
`_initialize`, rejects command modules exporting `_start`, and shares a one-time
startup guard with `start`. This is needed by WASI reactor loaders, including
the unmodified Oxc 0.94.0 fallback with stable emnapi 1.11.3. The previous source
and native Bun 1.4.4 both throw `wasi.initialize is not a function` there.

The catalog records the patched source SHA256 and preprocessed source SHA256.
Headers and the catalog name the pinned upstream revision, so rebuilding the
same patches with a different Git committer timestamp produces identical output.
The standard generator lowers Bun's intrinsic references and exports into the
existing factory format. The generated file retains the upstream source and
revision header. Bun's license remains in the generated builtin directory.

`node:wasi` depends on `node:fs`, `node:path`, and `node:tty`. These dependencies
use the existing runtime adapters. Explicitly selected public modules are still
generated, and internal dependencies still traverse their closure. Unselected
public dependencies stop before traversal. This matches the loader's existing
fallback for `bun`, `node:*`, and `bun:*`. Unknown module, native module, and
architecture checks remain unchanged.

Only generated module 188 and its catalog row change for reactor support.
Existing modules 22, 167, 168, registry and bindings remain byte-identical.
The constants hook
adds 84 compact bytes to the loader, from 3,376 to 3,460, within its unchanged
4,092-byte bound. The syntax check removes only the explicitly asserted hook
before comparing every original executable token.

## Verification

`checks/quality-runtime-wasi.json` discovers `scripts/runtime-wasi.test.ts`.
Its real host control executes a WASM module that imports WASI argument,
environment, random, file-open, file-write, file-read, and file-close operations.
It checks exact UTF-8 bytes, native file contents, descriptor closure, and EBADF.
The control closes its descriptors and removes its scratch directory on failure
or success. It also verifies that the constants hook remains lazy and only
generated module 188 loads. A real reactor calls a WASI import from `_initialize`,
proving memory was bound before initialization. Additional controls cover the
optional initializer, invalid exports, initializer exceptions, and repeated or
mixed `start`/`initialize` calls.

Focused generator tests exercise excluded public dependencies, explicit public
selection, internal closure, and the existing guards. Interpreter threads,
shared-memory behavior and application execution are separate gates. The exact
published Oxc fallback also parses valid TypeScript and reports invalid syntax
with this generated WASI source on native host WebAssembly. This does not claim
a rebuilt guest or Nuxt application acceptance.
