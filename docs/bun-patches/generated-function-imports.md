## Generated function imports

`crates/bunwasm-runtime/src/js/function.ts` is an original adapter for the public
Function, AsyncFunction, GeneratorFunction and AsyncGeneratorFunction constructors.
It uses the caller-origin helper and Bun parser keyword positions to route
generated dynamic imports through the runtime resolver. No Bun, Node, QuickJS or WebKit implementation is
copied. Native constructors still parse the arguments and construct the function. On QuickJS
and the host engine, native parsing validates the original function before Bun's
parser identifies replacements. Methods named `import` remain intact and invalid
original syntax still throws. Temporary
validation functions are never executed. JSC keeps its native constructors because
its generated imports already preserve the caller origin. The host adapter also
attaches the creating module's source URL to generated bodies. Otherwise the
constructor proxy itself would replace available eval-origin metadata with an
internal runtime location, even in a body without an import. This directive is
visible in generated function source, as is the dynamic-import replacement.
This fixes the published Prettier 3.6.2 CLI's generated import without changing
its package or fixture. Caller-origin lookup temporarily uses the runtime's own
stack formatter so user custom formatters cannot change module resolution.

The adapter is now a strictly checked TypeScript factory. The parser kind is a
closed union, and native import-position, resolution and module-loading
contracts live in `src/js/runtime.d.ts`. Offset replacement uses a separate
helper to keep nesting bounded; it still applies descending parser offsets to
the same constructor argument strings. No upstream code is copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/function.ts`](#generated-function-imports) | Host feature | Original generated-function adapter with module-relative dynamic imports. |

[Ledger scope and pinned revisions](scope.md).
