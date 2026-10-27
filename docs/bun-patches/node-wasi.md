# Bun WASI builtin

The runtime exposes Bun's existing `node:wasi` implementation through the builtin
loader. WASI modules can call the filesystem and other process adapters already
available to the runtime. The source control runs actual WASM imports on Bun's
native host WebAssembly with native filesystem calls. This is a standalone WASI
capability, not Nuxt acceptance or shared-memory support in the Wasmi interpreter.

## Source and changes

| Source | Class | Local change |
| --- | --- | --- |
| Bun `src/js/node/wasi.ts` | Port | Include the existing generated factory as module 188. No WASI implementation changes. |
| Builtin registration, constants hook, and selection policy | Original adapter | Route `node:wasi` to the factory, supply existing filesystem constants lazily, and retain existing adapters for unselected public dependencies. |

The source comes from Bun relevant-source revision
`9510e74152073d850a18758ca41114d8f214ffa6`, in the pinned patched checkout
`2c7a5e6823e94e1ec92be4c4b49480964230b225`. Its SHA256 is
`9c07eb223e2d9b1700fec1f243ac2bcddf72de39616e568ecb3850ca0b8c186f`.
The standard generator lowers Bun's intrinsic references and exports into the
existing factory format. The generated file retains the upstream source and
revision header. Bun's license remains in the generated builtin directory.

`node:wasi` depends on `node:fs`, `node:path`, and `node:tty`. These dependencies
use the existing runtime adapters. Explicitly selected public modules are still
generated, and internal dependencies still traverse their closure. Unselected
public dependencies stop before traversal. This matches the loader's existing
fallback for `bun`, `node:*`, and `bun:*`. Unknown module, native module, and
architecture checks remain unchanged.

Only generated module 188 and its registry row are added. Existing modules 22,
167, and 168, the catalog, and bindings remain byte-identical. The constants hook
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
generated module 188 loads.

Focused generator tests exercise excluded public dependencies, explicit public
selection, internal closure, and the existing guards. Interpreter threads,
shared-memory behavior, package-specific emnapi initialization, and application
execution are separate gates.
