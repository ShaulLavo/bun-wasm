# QuickJS statement parser without native recursion

Class **Port**. The upstream source is QuickJS-ng 0.16.2 in rquickjs-sys 0.13.0,
imported at `902364cf9`. The local file is
`third_party/rquickjs-sys/quickjs/quickjs.c`.

Upstream parses statements by recursive descent: `js_parse_statement_or_decl`
calls itself, `js_parse_block` and `js_parse_statement` once for every nested
statement. On a wasm host each level costs call frames the guest cannot see,
so the WASI port reserves shadow-stack bytes for them
([Wasm stack guards](wasm-stack-guards.md)). At the 32 and 36 KiB budgets
browsers off V8 get, that left room for about 61 and 70 nested `if (x) {`
levels. Generated code nests deeper: the schema validators in the webpack
bundle Next ships open one `if` block per property, 80 deep, so `next dev`
failed while compiling it on desktop Safari.

This changes the upstream algorithm, which the stack-guard port does not.
`js_parse_statement_or_decl` keeps its signature and callers and becomes a
loop. A statement that contains statements keeps what it needs after its child
in a `JSParseStmtFrame` record instead of C locals, and the loop parses the
child in the same C frame. Nested statements therefore add no native frames.
The emitted bytecode, debug tables, stored source, error messages and error
positions do not change.

| Upstream code | Local form |
| --- | --- |
| `js_parse_statement_or_decl` | The driver loop. Not inlined, so the function-declaration cycle through `js_parse_source_element` does not carry its frame. |
| The body of `js_parse_statement_or_decl` up to each recursive call | `js_parse_stmt_begin`. Statements without a child statement finish there as before. |
| `js_parse_block` | `js_parse_stmt_begin_block`, `js_parse_stmt_resume_block` |
| Code after the recursive call in the `if`, `while`, `do`, labelled and `with` cases | `js_parse_stmt_resume_if`, `js_parse_stmt_resume_do` and the short cases of `js_parse_stmt_resume` |
| Code after the body of an ordinary `for` | `js_parse_stmt_resume_for` |
| `js_parse_for_in_of` | Its head keeps the name. Its tail is `js_parse_stmt_resume_for_in_of`. |
| The clause loop of `switch` | `js_parse_stmt_switch_clauses`, entered again after each statement of the body |
| The `try`, `catch` and `finally` sequence | `js_parse_stmt_resume_try`, `js_parse_stmt_try_catch`, `js_parse_stmt_try_finally` |
| `js_parse_statement` | Removed. Its callers ask the driver for a child statement. |

Each helper keeps upstream's statements in upstream's order, so a later
upstream change to one statement kind maps onto one begin step and one resume
step.

## Records and ownership

Records live in chunks of 16 that never move, because `fd->top_break` holds
the addresses of the `BlockEnv` entries inside them. A record's storage exists
before any entry in it is linked. Pushing a record takes the statement's label
atom only when the push succeeds.

Functions inside expressions re-enter the driver through
`js_parse_function_decl2`. Each entry remembers its function, its starting
record depth and the break chain it found. On failure it restores that chain
and pops only its own records, freeing their label atoms once. A nested
function has already unwound its own records by then, so no entry follows a
function definition that was freed.

The chunk pool belongs to the parse. `__JS_EvalInternal` releases it as soon as
`js_parse_program` returns, before function creation, module resolution and
execution, which can each start another parse. The JSON parser shares
`JSParseState` and never allocates a chunk.

## The record limit

`JS_PARSE_STMT_DEPTH_MAX` is 10,000 records suspended at once in one parse,
including those of enclosing functions. Past it the parser throws the same
catchable `RangeError: Maximum call stack size exceeded` the stack guard
throws, and the engine continues.

The limit counts records, not source statements. A statement that contains a
statement holds one record, and a braced body adds one for its block: a braced
`if` nests 5,000 deep and an unbraced one 10,000. A label directly on a loop
shares the loop's record. The body of a function adds none, but its enclosing
function's records stay counted.

This is a deliberate resource bound, accepted for this change, not a syntax
rule. On hosts with large stacks it is lower than before: the native launcher
accepted 17,456 nested blocks and 21,815 unbraced `if` levels at its 4096 KiB
budget. In browsers it is far higher than the stack allowed.

It bounds record storage, about 1.1 MB at the limit on wasm32, and nothing
else. Scopes and function definitions accumulate across sibling statements,
and a few forms have their own costs: every name inside nested `with` blocks
compiles to one lookup per enclosing `with`, so a few thousand levels exhaust
memory in code generation with a catchable error.

Compiling a deep body is separate from running it. A nested `switch`,
iterator or `catch` keeps a value slot per level at run time, and the
interpreter's own guard still applies to those.

## What stays recursive

Expressions, function nesting, classes and literals recurse as before and keep
`next_token`'s guard and their reservations. The driver keeps the 96-byte
reservation once per entry. At 32 KiB, functions nested through `if`, `for`,
`try` and `switch` bodies compile about 105 levels deep instead of 38 to 59,
and no measured path is shallower than before
([Stack limits](../stack-limits.md)).

## Checks

`scripts/check-quickjs-parser-stack.ts` builds the bare engine with
`scripts/fixtures/quickjs-parser-stack.c` and checks the limit at its exact
boundary for one-record, two-record, labelled and wrapped shapes and across
nested functions, refusal and recovery at depth 200,000, release of the pool
before execution, and every denied record-chunk allocation. That fault sweep
covers the record pool only, with the input shifted to all 16 positions in a
chunk. It is not a sweep of every allocation in a compile: upstream aborts on
`assert(cpool_idx >= 0)` in `js_create_function` when an allocation fails
during function creation, with or without this change.
`scripts/fixtures/quickjs-parser-stack.ts` holds statement semantics whose
expected output, `quickjs-parser-stack.expected.txt`, is what the upstream
recursive parser printed before this change.

`tests/fixtures/stack-statement-nesting` runs on every engine with one expected
output, at the 32 KiB budget where QuickJS's parser compiles the source: a
200-property validator through `eval`, the `Function` constructor, `require`
and `import()`, every statement kind nested, completion values, label,
`finally` and iterator-close order, declaration contexts and source positions.
`tests/fixtures/quickjs-parser-deep` compiles about 4,900 levels of each
statement family at 32 and 36 KiB and enforces the limit on QuickJS. Both
recognise QuickJS's parser by the wording of one of its early errors, because
`process.versions` is the same on every engine. JSC reads the same budget
variable and refuses 200 nested blocks at 32 KiB in its own parser, so other
engines keep the budget they were started with.

During development a native driver compiled the same inputs with the upstream
parser and this one and compared the serialized bytecode, debug tables and
source byte for byte: the runtime's embedded modules, tracked test JavaScript,
the 764 compiled files of Next 15.5.6 in both module kinds, generated statement
permutations in six contexts and seeded truncations. That comparison needs the
previous compiler, so it is not a CI check.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `quickjs.c`, statement parser | Port | Parse nested statements in a loop over parser-owned records instead of recursive calls, with a limit of 10,000 suspended records. |
| `scripts/check-quickjs-parser-stack.ts`, `scripts/fixtures/quickjs-parser-stack.c`, `scripts/fixtures/quickjs-parser-stack.ts` | Original adapter | Exercise the record limit, ownership and statement semantics on the bare engine. |
| `tests/fixtures/stack-statement-nesting`, `tests/fixtures/quickjs-parser-deep` | Original adapter | Exercise deep statement nesting through the guest entry point at the browser budgets. |

[Ledger scope and pinned revisions](scope.md).
