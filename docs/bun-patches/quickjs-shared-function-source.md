## QuickJS function source shared per parse

Class **Host feature**. This changes `quickjs/quickjs.c` from the QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`. Upstream QuickJS-ng has no equivalent at this revision.

QuickJS keeps each function's text so that `Function.prototype.toString` can return it. It copied that text into a private buffer per function (`js_strndup` in `js_parse_function_decl2` and the class constructor in `js_parse_class`). A function's text contains the text of every function nested in it, so a module wrapper around nested functions stored its source once per nesting level. The source of webpack's bundle plus Next's app-page runtime, 3.67 MiB, cost 25.41 MiB of QuickJS memory, 20.11 MiB of it function data. A Next.js dev server loads about 25 MiB of CommonJS source, which left it close to the 512 MiB guest limit before the first edit.

The parser now borrows each function's text from the parse input. After a successful parse, `js_share_function_sources` copies the span covering every function of that parse into one reference-counted `JSSharedSource`, and each function's `source` points into it. Each bytecode holds a reference, released in `free_function_bytecode` and, for failed compilations, in `js_free_function_def`. The same input now costs 11.99 MiB. `toString` output is byte-identical. Bytecode read by `JS_ReadObject` still owns a private copy (`source_owner` is null). `JS_ComputeMemoryUsage` counts a shared span once, split across its functions.

The span excludes text outside every function, such as a trailing `//# sourceMappingURL` comment in webpack's `eval` modules. A surviving closure keeps its whole parse span alive. That is the same text the enclosing functions kept before.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, function source](#quickjs-function-source-shared-per-parse) | Host feature | Share one reference-counted copy of a parse's function text instead of one copy per function. |
| [`crates/bunwasm-engine-quickjs/src/vm.rs`, tests](#quickjs-function-source-shared-per-parse) | Host feature | Bound the function data retained by nested functions, and check `toString` after the parse input is gone. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
