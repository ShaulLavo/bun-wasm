# Runtime-built JavaScript preparation

| Implementation | Class | Upstream | Local change and reason |
| --- | --- | --- | --- |
| Patch 0018, parser source spans | Host feature | Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js_parser/lexer.rs and parse/* | Adds previous-token-end and a guarded parse-side span collector. These records locate original await/yield/eval/function/handler/loop spans without printing or rewriting user text. |
| Patch 0018, eval argument printing | Host feature | Same Bun revision, src/js_printer/lib.rs | Wraps first non-spread eval arguments while retaining the original direct-eval callee. Raises preparation version to 5. Parent patch 0008 owns await/rejection/iterator shapes. |
| prepare.rs, source_prepare.ts and function.ts | Original adapter | No copied upstream implementation | Applies fixed newline-free insertions over original UTF-16 source; one byte-bounded LRU caches only versioned edit records. Constructor proxies retain native apply/construct/newTarget and prototype routes. |
| vm, module_compile.ts and script-evaluation.ts | Original adapter | No copied upstream implementation | Prepares whole executable wrappers, registers bounded versioned source-column tables, and corrects columns before line/source-map offsets. |

The patch is exported only from CTX02b's private vendor branch. Number 0017 is reserved by the Hermes records lane. Patch 0008 is unchanged.

The cache key includes preparation version, process/thread realm, parse goal with constructor argument lengths, map policy c1, and original payload. Edit and column vectors are Int32Array values. No compiled function, closure, request frame, AsyncLocalStorage store, or native object reference enters the compiled-text cache. Entries above 4 MiB are not cached; the key-plus-vector budget is 16 MiB. Named column tables replace previous HMR entries and are bounded by bytes and entry count. Exit drops both registries.

Runtime preparation preserves all original text outside edits, including comments, directives, sourceURL/sourceMappingURL, and lone UTF-16 surrogates. A sanitized parse copy preserves surrogate code-unit lengths; JS edits the original string. Parse failure returns no edits and leaves native SyntaxError behavior in charge. The _compile body validation remains to prevent executable wrapper breakout, then the entire executable wrapper goes through preparation.

The original constructor import-only API is removed. The same preparation call returns import locations and async/eval edits. Non-host engines request import edits only; a host native continuation provider bypasses hook preparation.

The preparation counter/trace entry is exposed through bun:internal-for-testing. BUN_WASM_PREPARE_TRACE=1 records version, realm, goal, map policy, origin, name, bytes, edits, milliseconds, cache hit and fallback. This is evidence about the origin of code, not a full-language guarantee.

The raw `.mjs` regression fixture deliberately has no suspension keyword. Its plain-JavaScript loader path must still prepare its eval call site, which a TypeScript fixture cannot prove. The rest of the new fixture and host code is TypeScript.


Revision 5 includes yield-only async generators and conservatively parses Unicode-escaped identifiers at both runtime and plain-JS file boundaries. A literal keyword absence check cannot prove the absence of a lexical intrinsic call.

Simultaneously live constructors have distinct immutable mapping identities. A generated sourceURL fragment carries the version, original explicit display name, caller origin and column vector. Original sourceURL comments remain in the body; keeping the effective URL's original prefix preserves relative sourceMappingURL resolution. Runtime formatters decode positions before displaying the original name and do not apply an unrelated caller-file source map. Metadata lives with the engine's generated code, including nested closures and retained errors. No callable, scope, frame, finalizer or strong global mapping registry is added. The existing 16 MiB text cache remains vectors and scalar metadata only; named eval/vm/HMR tables remain independently bounded.
