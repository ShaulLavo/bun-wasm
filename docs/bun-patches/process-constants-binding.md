# Process constants binding

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/process.ts` | Original adapter | Expose existing builtin constants through the private process binding used by Prisma's bundled temporary-file helper. |

This is original bun-wasm code. No upstream implementation is copied or patched.
The API shape follows Bun's `test/js/node/process-binding.test.ts` at upstream
revision `9510e74152073d850a18758ca41114d8f214ffa6`.

`process.binding("constants")` constructs and caches a null-prototype object on
its first call. Its `fs`, `os`, `crypto` and `zlib` properties are writable,
enumerable, configurable data properties containing the existing public builtin
constants. Assignment, deletion and redefinition persist on the cached object,
matching native Bun and Node. The builtins load at the binding call, preserving
lazy process initialization without accessor-only properties or a proxy.
First-call source controls exercise the actual builtin factories without cycles.
Existing numeric constant values and native operations remain unchanged.
Unsupported binding names still throw. Trace constants are not supplied.

The real Prisma 6.17.1 CLI reaches this binding before command dispatch. Its
bundled `tmp` module reads filesystem open flags and OS errno constants. The
regression exercises the exact flag expression against the actual runtime
bootstrap and builtin factories, and checks object identity and unknown names.
The shared native fixture covers prototype, data descriptors, assignment,
deletion, redefinition and cached identity under Node, Bun and the source runtime.
The process AST receipt matches this exact delta before checking the original
pinned hash, and mutation controls reject changed lookups, guards and unrelated
process syntax.
