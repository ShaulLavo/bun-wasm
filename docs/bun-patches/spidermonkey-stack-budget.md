# SpiderMonkey host stack quota

## Classification

`crates/bunwasm-spidermonkey/cpp/stack-budget.h` is an original adapter. It
configures Mozilla's `JS_SetNativeStackQuota` in the production engine and the
standalone smoke. It targets `js/public/Stack.h` and `js/src/jsapi.cpp` at
Mozilla revision `a5df22d986d4b626f771b4f8885241941601c35c`.

## Changes and reasons

Read `BUN_WASM_SPIDERMONKEY_STACK_KIB` once when initializing the context. A
positive decimal value selects the quota, clamped to 7 MiB and to the member's
available stack. SpiderMonkey never reads `BUN_WASM_STACK_KIB`, the QuickJS and
JSC budget: values sized for those engines (32 KiB, as fixtures pass to child
processes) are far below the roughly 100 KiB SpiderMonkey needs to start, and
the native launcher sets that variable to 4096 for every guest.
Missing, zero and malformed values retain the available-stack default. Both
embeds keep 64 KiB between their largest quota and the bottom of the member's
shadow stack. The standalone smoke verifies the installed native stack limits.

The host call stack is separate from this shadow stack. Selecting a quota is
safe only after measuring every recursive path on the host that will use it.
The browser host passes 188 KiB on WebKit (`web/src/engine-stack-budget.ts`);
`docs/stack-limits.md` records the measurements.

## Upstream reservations

The WASI embed patch changes `js/public/friend/StackLimits.h`,
`js/src/vm/Interpreter.cpp`, `js/src/vm/PortableBaselineInterpret.cpp`,
`js/src/frontend/Parser.cpp`, `js/src/frontend/BytecodeEmitter.cpp`,
`js/src/builtin/JSON.cpp` and `js/src/builtin/Array.cpp` at the same revision.
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
worker stack (an M1 Mac, and Linux under `ulimit -s 512`). The runtime sizes
come from the largest quota at which unbounded input on each shape is still
caught. The compile sizes come from two numbers per shape: the deepest level
that compiles cold with no quota (where the host stack ends) and the deepest
level 188 KiB accepts. Each compile size keeps the second at or below 80
percent of the first on both hosts and tiers, while adding as little as
possible to what Next's webpack hook and Angular's schema validators need.

| Site | Tier | Reserved bytes | Covered recursion | Sized by (binding shapes) |
| --- | --- | ---: | --- | --- |
| `RunScript`, shallow stack | interp | 1840 | Native calls into scripts: the program's own entry chain and the start of any recursion | `getter`, `ajv` |
| `RunScript`, shallow stack | PBL | 2304 | The same, entering PBL through its trampoline | Compiles under the program's own PBL entries (main's size, kept; the compile sizes below were calibrated with it in place) |
| `RunScript`, deep stack (`bunwasm::StackIsDeep`) | both | 4096 | Runaway native recursion that remains after the interpreter loops: setters, computed getters, bound and proxy targets, array-like `apply`, coercion | Mac: PBL `stringify`, `proxy`, `toString` (caught up to 218 to 229 KiB), interp `computed` (224 KiB) |
| `CallWithWasmStackReservation` around three recursive calls in `ICInterpretOps` | PBL | 384 | Scripted calls, getters and setters reached through inline caches before the stack is deep | `ajv`, `getter` |
| `SerializeJSONProperty` | both | 896 | Nested arrays and objects in `JSON.stringify` | `stringify` |
| `array_join` | both | 1536 | Nested arrays converted to strings | `join` |
| `statementListItem` (in `statementList`'s frame, and `switchStatement`'s, since the [parser frame merges](spidermonkey-frontend-frames.md)) | both | 640 | Every statement in a block, function body or `switch` case | `validator` parsed lazily; also `blocks`, `ifs`, `switches` |
| `ifStatement` | both | 256 | `if` statements, braced or not | `validator` parsed lazily, with the 640 above |
| `tryStatement` | both | 288 | `try` statements, whose blocks go straight to `statementList` | `tries` parsed lazily, with the 640 above: at 216 KiB without it, refusing lazily parsed `try` nesting ran out of host stack on the Mac's interpreter tier |
| `statement` | both | 1104 | Statements that are a label's target or a body: loop, `with` and unbraced `if` bodies | `labels`; also `fors` compiled in full, `labelWhile`, `unbracedWhiles` |
| `assignExpr` | both | 880 | Every expression level. Alone: conditional, assignment, arrow and `yield` chains | `ternary` |
| `unaryExpr` | both | 592 | Every expression level. Alone: unary operator, `typeof`, `delete`, `await` and `++` chains | `unary`, `typeofs` (the constant folder is their deepest pass) |
| `memberExpr` | both | 848 | Every member or primary expression. Alone: `new` chains | `commas`, `parens`, `index`, with the two above |
| `argumentList` | both | 464 | Nested call arguments | `calls` |
| `templateLiteral` | both | 512 | Nested template substitutions | `templates` |
| `functionFormalParametersAndBody` | both | 1696 | Nested function bodies of every kind | `functions`, `classes`; also `iifes`, `methods`, `arrows` (main's size, kept) |
| `emitTree` | both | 416 | The bytecode emitter's walk of a function compiled in full | `validator`, `tries` and `blocks` compiled in full |
| `arrayBindingPattern` | both | 1664 | Nested array patterns in declarations, parameters and `catch`, and the emitter's walk of them, which has no check of its own | `letArrays` and `letRests` compiled in full |
| `objectBindingPattern` | both | 1088 | Nested object patterns in the same places | `letObjects`, `catches` and `letRests` compiled in full |

### Compile sites follow the frames, not the constructs

A nesting level costs one host frame for every C++ function on its recursion
cycle. After the parser frame merges the functions that remain on a cycle are
few, so each holds a reservation for its own frame instead of one construct
holding the whole level's:

- A statement level is `statementList` plus the statement's own function
  (`ifStatement`, `whileStatement`, `tryStatement` and so on), and `statement`
  when the statement is a body or follows a label. `ifStatement` and
  `tryStatement` reserve for themselves because their braced blocks go straight
  to `statementList`; loops, `with` and labels parse their body through
  `statement`, and `switch` holds `statementListItem`'s in its own frame.
- An expression level is `assignExpr`, `unaryExpr` and `memberExpr`, plus
  `expr`, `argumentList` or `templateLiteral` for the bracket kinds that add one.
  Arrays, objects, element access, parentheses and function expressions need
  nothing beyond those three, so their own sites are gone.
- Chains that recurse through one function only are covered by that function:
  `a ? b : a ? b : c` and `a = a = b` through `assignExpr`; `!!a`,
  `typeof typeof a`, `delete`, `await` and `++` through `unaryExpr`;
  `new new A` through `memberExpr`; `l1: l2: s` through `statement`. The older
  table reserved for `?:` and `!` only.
- No reservation wrapper frame is left in the parser. The never-inline wrappers
  around parenthesised expressions, function expressions and both branches of
  `?:` each added a host frame to the cycle they guarded.
- A binding pattern level (`let [[x]]`, `function f({ a: { b } })`,
  `catch ({ a: { b } })`, `for (let [[x]] of y)`) is `arrayBindingPattern` or
  `objectBindingPattern` plus `bindingIdentifierOrPattern`. Patterns in an
  assignment or arrow parameters are parsed as expressions first and take the
  expression level's. Until November 15, 2026 neither pattern function
  reserved, so nesting 20,000 deep ran the WebKit host stack out on both tiers.

Every recursion cycle passes a function that checks the quota, and the check
sees every reservation held above it. Only the cycles the measurement probe
nests are known to hold a reservation; a cycle it does not nest may hold none
and then needs its own site, as binding patterns did.

Parsing is not the deepest pass for everything. A function is parsed lazily
(syntax only) when it is declared and compiled in full on its first call: full
parse, constant folding, function naming, then the emitter. For braced
statements the emitter spends more host stack per level than the parser: a
cold `if` level takes three `emitTree` frames and three more, and plain blocks
and `try` blocks reach only about 60 percent of their lazily parsed depth when
compiled. So the emitter reserves for itself. A validator-shaped function that
the lazy parse accepts can therefore be refused on its first call, with the same
catchable `RangeError`. For unary chains the constant folder is the deepest pass
and `unaryExpr`'s size covers it. Binding patterns are the opposite case: the
emitter's walk of a nested pattern (`emitDestructuringOps` and its callees)
checks neither the counter nor the quota, so only the parse can refuse. An array
pattern takes more host stack there than an object pattern, so
`arrayBindingPattern` reserves more, and both sizes keep the depth the parse
accepts at 188 KiB at or below 75 percent of the depth a cold full compile holds.

Shapes are those of the measurement probe: unbounded `down(n)` recursion through
each runtime path, and one construct nested 20,000 deep, compiled by `eval` as
dead code and as the body of a function that is declared and then called. Self-hosted
callbacks such as `reduce` are plain in-loop calls and need no site of their
own: the `ajv` shape costs what its getter costs. Runtime reservations stay at
the shared entries (script entry and PBL's cache-interpreter calls), never inside
`js::CallGetter`, `fun_call` or the bound-call path, so moving one path into the
interpreter loop removes it from an entry's coverage. That entry is then
re-sized from its remaining binding shapes.

The script-entry size also follows the stack
([PBL hand-over](spidermonkey-pbl-handover.md)). A program's own entries are
shallow and pay the tier's size, so Next's need and the compile shapes stay
where main had them. Recursion that keeps the native route goes deep, where each
entry pays 4096 bytes on either tier and the quota fires early enough. This
replaced the PBL-only proxy-trap site of 1792 bytes: on PBL, getters, `call` and
`apply` continue in the C++ interpreter's loop once the stack is deep, and the
native routes that remain, proxy traps included, pay the deep entry size.

Remove a site's reservation when its calls stay inside the interpreter loop.

## Test adaptation

The S15 engine-semantics control (`crates/bunwasm-spidermonkey/tests/engine-semantics.cpp`)
looks for the shadow depth at which `require_loaded`'s own check refuses. It now scans
4 KiB past the first refusal, as S16 already did, because the PBL script-entry reservation
lies between the deepest check and that one.
