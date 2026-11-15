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
The browser host passes 188 KiB on WebKit (`web/src/engine-stack-budget.ts`);
`docs/stack-limits.md` records the measurements and the known gap.

## Upstream reservations

The WASI embed patch changes `js/public/friend/StackLimits.h`,
`js/src/vm/Interpreter.cpp`, `js/src/vm/PortableBaselineInterpret.cpp`,
`js/src/frontend/Parser.cpp`, `js/src/builtin/JSON.cpp`,
and `js/src/builtin/Array.cpp` at the same revision.
This is a port change. Uninitialized, address-escaped stack memory reserves
shadow bytes until the reserving frame returns: a fixed array in the recursive
function itself (`BUNWASM_RESERVE_STACK`), a never-inlined wrapper around one
recursive call (`BUNWASM_RESERVED_CALL`), or an `alloca` whose size depends on
the stack's depth (`BUNWASM_RESERVE_STACK_DYNAMIC`). No bytes are filled and no
error-path bookkeeping is needed. Every macro is empty without
`__wasi__ && BUNWASM_EMBED`. The sizes live in one place, `js::bunwasm` in
`StackLimits.h`.

The host stack a recursion level uses is invisible to wasm, so each size was
measured: in the guest in a fresh Playwright WebKit page on Darwin's 512 KiB
worker stack (an M1 Mac, and Linux under `ulimit -s 512`), as the largest quota
at which unbounded input on each shape is still caught. Each size lifts its
shapes above 188 KiB on the Mac while adding as little as possible to what
Next's webpack hook needs.

| Site | Tier | Reserved bytes | Covered recursion | Sized by (binding shapes) |
| --- | --- | ---: | --- | --- |
| `RunScript`, shallow stack | both | 1840 | Native calls into scripts: the program's own entry chain and the start of any recursion | Next's webpack hook on PBL (181 KiB needed), with `getter` and `ajv` before the PBL hand-over |
| `RunScript`, deep stack (`bunwasm::StackIsDeep`) | both | 4096 | Runaway native recursion that remains after the interpreter loops: setters, computed getters, bound and proxy targets, array-like `apply`, coercion | `proxy`, `toString`, `computed`, `setter` on the Mac |
| `CallWithWasmStackReservation` around three recursive calls in `ICInterpretOps` | PBL | 384 | Scripted calls, getters and setters reached through inline caches before the stack is deep | `ajv`, `getter` |
| `SerializeJSONProperty` | both | 896 | Nested arrays and objects in `JSON.stringify` | `stringify` |
| `array_join` | both | 1536 | Nested arrays converted to strings | `join` |
| `statement` | both | 336 | Labels and sub-statements (`if`, loop and `with` bodies) | `labels`, with `ifs`, `validator`, `labelWhile` |
| `statementListItem` | both | 352 | Statements inside blocks and function bodies | `blocks`, with `ifs`, `validator`, `labelWhile` |
| `functionFormalParametersAndBody` | both | 1696 | Nested function bodies | `functions`, `methods`, `classes`, `arrows` |
| `functionExpr` in `primaryExpr` | both | 2880 | Nested function expressions | `iifes` |
| `argumentList` | both | 2800 | Nested call arguments | `calls` |
| `arrayInitializer` | both | 2816 | Nested array literals | `arrays` |
| `objectLiteral` | both | 2784 | Nested object literals | `objects`, `methods` |
| `memberElemAccess` | both | 2784 | Nested element access brackets | `index` |
| `templateLiteral` | both | 3248 | Nested template substitutions | `templates` |
| both branches of `condExpr` | both | 1088 | Conditional chains | `ternary` |
| parenthesized expression in `primaryExpr` | both | 3072 | Nested parentheses | `parens`, `iifes` |
| `unaryOpExpr` | both | 464 | Unary operator chains | `unary` |

The statement sizes stay small on purpose. Next's deepest compile path is 83
levels of statement nesting, so raising them raises Next's need as fast as the
shapes' capacity (`docs/stack-limits.md`, the known gap).

Shapes are those of the measurement probe: unbounded `down(n)` recursion through
each runtime path, and `eval` of one construct nested 20,000 deep. Self-hosted
callbacks such as `reduce` are plain in-loop calls and need no site of their
own: the `ajv` shape costs what its getter costs. Runtime reservations stay at
the shared entries (script entry and PBL's cache-interpreter calls), never inside
`js::CallGetter`, `fun_call` or the bound-call path, so moving one path into the
interpreter loop removes it from an entry's coverage. That entry is then
re-sized from its remaining binding shapes.

The script-entry size follows the stack rather than the tier
([PBL hand-over](spidermonkey-pbl-handover.md)). A program's own entries are
shallow and pay 1840 bytes, so Next's need stays where it was. Recursion that
keeps the native route goes deep, where each entry pays 4096 bytes and the quota
fires early enough. This replaced a PBL-wide 2304-byte entry and a PBL-only
proxy-trap site of 1792 bytes: on PBL, getters, `call` and `apply` now continue
in the C++ interpreter's loop once the stack is deep, so the shapes that sized
those entries no longer reach them.

Remove a site's reservation when its calls stay inside the interpreter loop.

## Test adaptation

The S15 engine-semantics control (`crates/bunwasm-spidermonkey/tests/engine-semantics.cpp`)
looks for the shadow depth at which `require_loaded`'s own check refuses. It now scans
4 KiB past the first refusal, as S16 already did, because the PBL script-entry reservation
lies between the deepest check and that one.
