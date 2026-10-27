# Process constants binding

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/process.ts` | Original adapter | Expose existing builtin constants through the private process binding used by Prisma's bundled temporary-file helper. |

This is original bun-wasm code. No upstream implementation is copied or patched.
The API shape follows Bun's `test/js/node/process-binding.test.ts` at upstream
revision `9510e74152073d850a18758ca41114d8f214ffa6`.

`process.binding("constants")` returns one cached object. Its `fs`, `os`, `crypto`
and `zlib` properties lazily return the corresponding public builtin's constants.
This avoids loading filesystem and crypto modules during process initialization.
It preserves the runtime's existing constant values and native operations.
Unsupported binding names still throw. Trace constants are not supplied.

The real Prisma 6.17.1 CLI reaches this binding before command dispatch. Its
bundled `tmp` module reads filesystem open flags and OS errno constants. The
regression exercises the exact flag expression against the actual runtime
bootstrap and builtin factories, and checks object identity and unknown names.
The existing process AST receipt removes only this explicit delta before checking
the original pinned hash.
