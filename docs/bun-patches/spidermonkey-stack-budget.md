# SpiderMonkey host stack quota

## Classification

`crates/bunwasm-spidermonkey/cpp/stack-budget.h` is an original adapter. It
configures Mozilla's `JS_SetNativeStackQuota` in the production engine and the
standalone smoke. It targets `js/public/Stack.h` and `js/src/jsapi.cpp` at
Mozilla revision `a5df22d986d4b626f771b4f8885241941601c35c`.

## Changes and reasons

Read `BUN_WASM_STACK_KIB` once when initializing the context. A positive decimal
value selects the quota, clamped to 7 MiB and to the member's available stack.
Missing, zero and malformed values retain the available-stack default. Both
embeds keep 64 KiB between their largest quota and the bottom of the member's
shadow stack. The standalone smoke verifies the installed native stack limits.

The host call stack is separate from this shadow stack. Selecting a quota is
safe only after measuring every recursive path on the host that will use it.

## Upstream reservations

The WASI embed patch changes `js/public/friend/StackLimits.h`,
`js/src/vm/Interpreter.cpp`, `js/src/vm/PortableBaselineInterpret.cpp`,
`js/src/frontend/Parser.cpp` and `js/src/builtin/JSON.cpp` at the same
revision. This is a port change. Address-escaped, uninitialized local arrays
reserve shadow bytes until the reserving frame returns: either the recursive
function itself (`BUNWASM_RESERVE_STACK`) or a never-inlined wrapper around one
recursive call (`BUNWASM_RESERVED_CALL`). No bytes are filled and no error-path
bookkeeping is needed. The sizes live in one place, `js::bunwasm` in
`StackLimits.h`.

Each size makes one level of its path hold about 0.2 shadow bytes per host
byte that level uses on a cold (first-tier) 512 KiB WebKit worker, measured as
the deepest level each path completes with no quota and the largest quota at
which unbounded input is still caught.

| Site | Tier | Reserved bytes | Covered recursion | Sized by (binding shapes) |
| --- | --- | ---: | --- | --- |
| `RunScript` | interp and PBL | 720 | Native calls into scripts: call/apply, getters, setters, bound and proxy targets | interp `getter` and `ajv`; PBL `call`, `apply` and `proxy` |
| `CallWithWasmStackReservation` around three recursive calls in `ICInterpretOps` | PBL | 384 | Scripted calls, getters and setters reached through inline caches | PBL `ajv` and `getter` |
| `SerializeJSONProperty` | both | 224 | Nested arrays and objects in `JSON.stringify` | `stringify` |
| `statement` | both | 336 | Labels and sub-statements (`if`, loop and `with` bodies) | `labels`, with `ifs`, `validator`, `labelWhile` |
| `statementListItem` | both | 352 | Statements inside blocks and function bodies | `blocks`, with `ifs`, `validator`, `labelWhile` |
| `functionFormalParametersAndBody` | both | 448 | Nested function bodies | `functions`, `iifes`, `methods` |
| `argumentList` | both | 832 | Nested call arguments | `calls` |
| `arrayInitializer` | both | 624 | Nested array literals | `arrays` |
| `objectLiteral` | both | 576 | Nested object literals | `objects` |
| `memberElemAccess` | both | 720 | Nested element access brackets | `index` |
| `templateLiteral` | both | 768 | Nested template substitutions | `templates` |
| both branches of `condExpr` | both | 288 | Conditional chains | `ternary` |
| parenthesized expression in `primaryExpr` | both | 688 | Nested parentheses | `parens`, `iifes` |
| `unaryOpExpr` | both | 192 | Unary operator chains | `unary` |

Shapes are those of the round 3 probe (`shapes.ts` beside the measurements). Self-hosted
callbacks such as `reduce` are plain in-loop calls and need no site of their own: the `ajv`
shape costs what its getter costs. Reservations stay at the two shared entries, never inside
`js::CallGetter`, `fun_call` or the bound-call path, so moving one path into the interpreter
loop removes it from an entry's coverage. That entry is then re-sized from its remaining
binding shapes.

Remove a site's reservation when its calls stay inside the interpreter loop.
No host family sets a SpiderMonkey quota yet, so these reservations only
change behavior when `BUN_WASM_STACK_KIB` is passed explicitly. The Apple value
is open: cold statement nesting and Next's webpack compile need quotas about
10 to 20 percent apart (`docs/stack-limits.md`).
