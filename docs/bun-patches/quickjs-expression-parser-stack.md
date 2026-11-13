# QuickJS binary expression parser stack

Class **Port**. The upstream source is QuickJS-ng 0.16.2 in rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`.

Upstream `js_parse_expr_binary` descends through eight precedence levels before it reads a unary expression. Every nested function keeps those frames alive while its body parses. The callback chain in Next 15.5.6's stock webpack bundle therefore refuses at the 32 KiB mobile budget even though its individual expressions are shallow.

The local parser reads the unary expression once. Its operator switch records the opcode and precedence together. For a binary operator, the parser reads the right operand at the next tighter level, emits the operator, and continues at the current level. This keeps left associativity and emission order without holding frames that cannot accept the next token.

The private-field `in` form retains its special lookahead and cleanup. After that form, parsing resumes at equality precedence, as it did when the old relational-level frame returned. Other operators, including `in` where the grammar rejects it, keep their old behavior.

`next_token` still checks for 1,000 bytes of stack. All frame reservations, stack budgets, parser errors, and public APIs stay unchanged. Deep expressions still fail with a catchable `RangeError`, and the parser continues after unwinding.

`tests/fixtures/quickjs-parser-reentry` compiles and runs 16 nested callback blocks at 32 KiB. It then forces deep-arrow overflow, checks recovery, and reloads the callback chain. `checks/native-quickjs-parser-reentry.json` gives the fixture normal native discovery.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `third_party/rquickjs-sys/quickjs/quickjs.c`, binary expression parser | Port | Parse binary operators by precedence without descending through every unused level. |
| `tests/fixtures/quickjs-parser-reentry` | Original adapter | Cover nested callback parsing, deep-parser overflow, and recovery at 32 KiB. |

[Ledger scope and pinned revisions](scope.md).
