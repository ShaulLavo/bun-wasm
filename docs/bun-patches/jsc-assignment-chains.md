# JSC assignment chains without parser recursion

Files `parser/Parser.cpp`, `parser/Parser.h` and `bytecompiler/NodesCodegen.cpp` under
`Source/JavaScriptCore` in `jsc/webkit-wasi.patch`, Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. Class **Port**.

## The problem

`parseAssignmentExpression` parses the right side of `a = b = c` by calling itself, so a chain of
assignment targets costs one host frame and one parser reserve per target. Generated CommonJS
exports are such chains (`exports.A = exports.B = … = void 0`). At the default reserve of 2048
bytes the full parse stops near 98 targets at 192 KiB ([Stack overflow in wasm](../stack-limits.md)).
Babel's `@babel/types` 7.29.11 `lib/builders/generated/uppercase.js` needs 101, so React Router,
SolidStart and TanStack Start stopped there on every 192 KiB host. Lowering the reserve is not
portable: the same function is on the nested call and nested function routes, which trap on a
small real host stack when the reserve is lower.

## The change

Upstream's function is cut at its operator loop into two always-inlined steps:

- `parseAssignmentLevelStart` is upstream's code from the function's entry to its operator loop:
  the entry assertion and stack check, `yield`, the arrow function candidate, the destructuring
  retry and the first operand. Its early returns are unchanged.
- `parseAssignmentLevelOperator` is upstream's operator loop, unchanged except at its call to
  itself. Upstream's six values that live across that call are references into the level's record.

Three real functions inline the two steps:

| Function | Role |
| --- | --- |
| `parseAssignmentExpression` (the entry) | Upstream's straight-line function. Where upstream called itself for the right side, it calls the chain level, and only if that level suspended does it call the chain driver. What followed upstream's call runs after it, unchanged |
| `parseAssignmentChainLevel` (the chain level) | One right side. A fresh level runs the entry's stack check. At its own operator it publishes its record on `m_suspendedAssignmentLevels`, sets `m_assignmentLevelSuspended` and returns. Resumed with its right side, or 0 when that failed, it removes its record and runs what followed upstream's call at the top of its loop |
| `parseAssignmentChainRest` (the chain driver) | Entered only by the entry, directly after a chain level published its record. A loop that calls a fresh chain level for each right side and resumes each published level with its right side, innermost first, until only the records below its base remain |

Each of the three reserves `2048` minus the parser reserve discount at its entry, so a chain of any
length holds three parser frames and three reservations, and a nest with one operator per level
(`a = f(b = f(…))`) holds upstream's two per level. Every route without an assignment operator
runs only the entry, with upstream's frame and reservation.

State and ownership:

- The flag is set only after the record is copied, and the level returns at once. The entry reads
  it immediately and hands it to the driver, which clears it before any further parsing. It is
  clear at every other function entry and exit.
- The driver owns the records above its base. It returns only with them all removed, on success
  and on failure, so a nested chain (in a parenthesized expression, an argument, a subscript, a
  conditional branch, an arrow candidate or a destructuring retry) never sees or changes its
  caller's records. A failed level never starts a fresh one: each published level is resumed with
  0, runs upstream's failure check and returns.
- The driver checks the stack under its own reservation before it starts a level. If it refuses,
  it drops its one published record and fails with the parser's stack error. A resumed level with a
  right side and no error checks under its reservation before it reduces, advances the lexer or
  meets another operator; with a failed right side it only removes its record and propagates.
- The builder's own assignment stack is left as upstream leaves it after a failure: nothing is
  truncated. Debug builds assert the flag and the record count at each boundary.

The vector has inline room for eight records of 44 bytes, so chains of up to nine targets allocate
nothing; the two vector operations are small out-of-line functions only a chain calls.

Bun's transpiler parses `require`d files first, with its own unguarded recursion; that is
unchanged.

The tree the parser now accepts is deeper, and the code generator walks it recursively. Its
`emitNode` checks only real shadow frames, which are small, so the nine emitters that recurse into
an assignment's right side (`AssignResolveNode`, `AssignDotNode`, `AssignBracketNode`, the three
`ReadModify*Node` and the three `ShortCircuitReadModify*Node`) reserve 1024 shadow bytes each, as
the unary emitters already do. `AssignErrorNode` emits a throw and does not recurse.
`emitNode`'s existing check then refuses a chain that is too deep: generation fails and the guest
gets a catchable `RangeError` with message `Out of memory`
(`BytecodeGenerator::generate`, `ParserError::OutOfMemory`, `createOutOfMemoryError`). A function
body is generated when it is first called, so an over-deep chain inside a function is refused at
that call, before any of its code runs. Before this change the parser refused it with
`RangeError: Maximum call stack size exceeded`, in the syntax check when the function was created
or in the full parse at its first call. Syntax errors inside a chain keep their class, and runtime
errors keep JSC's line and column. Source the old parser refused for depth may now reach its real
syntax error instead.

## Consumers of the deeper assignment spine

Checked against the edited source before the first build:

| Consumer | Source |
| --- | --- |
| Builder reduction | `ASTBuilder::createAssignment` pops one stack entry per target; `makeAssignNode` inspects only the target and right side's type tags |
| Constructors and queries | The nine node classes store child pointers. They have no recursive query overrides; `isPure` is the base `false` |
| Condition context | Assignment nodes inherit `ExpressionNode::emitBytecodeInConditionContext`, which goes through guarded `emitNode` |
| Right side | All nine emitters reach the right side only through `emitNode`, directly or through the inlined `emitReadModifyAssignment` and `emitShortCircuitAssignment`. `emitNode` is inlined into each emitter, so one generator level is one emitter frame and one indirect call |
| Teardown | Parser arena nodes have no destructors that recurse; the arena frees pools iteratively |

## Measurements

Launcher, November 12, 2026: a development side from this source paired with the ordinary split
core of `01e55ae3`. Full parse of a chained assignment, in targets:

| Budget | Before | After |
| ---: | ---: | ---: |
| 192 KiB | 98 | 230 |
| 208 KiB | 105 | 245 |
| 208 KiB, reserve 960 | 191 | 245 |
| 800 KiB | 353 | 794 |

The syntax-check pass loads every depth the probe tries (4,096). The nine forms in all positions
and widths stop between 220 and 233 targets at 192 KiB. Babel's `uppercase.js` loads alone at 176
and 192 KiB; before, both refused. The nine emitters lower the stack pointer by 1,040 to 1,088
bytes in their prologue, before the call that recurses. The interpreter frame gate is unchanged:
4,896 bytes held, 293 of 328 slots.

### Cost on other routes

The two steps are inlined: the side has no separate function for either, in all four parser
instantiations. The driver is still larger than upstream's function: 12,295 wasm instructions
against 9,451, 72 locals against 66, and 32 more bytes of shadow frame (ASTBuilder, 8-bit). Every
route through it pays that once per level:

- Guarded capacity of nested calls, conditional chains and nested functions falls by one to five
  levels at 192, 208 and 800 KiB. Blocks are unchanged.
- With the guest guard out of the way, those routes exhaust a cut host stack earlier. Wasmtime at
  512 KiB: nested calls 480 to 374, conditional chains 976 to 619, nested functions 165 to 147.
  V8 (a Node worker) at 1 MiB: 780 to 720, 1,680 to 1,348, 364 to 354. Blocks are unchanged.

At the shipped budgets the guard still stops every route first: no trap in any sweep, and on V8 at
800 KiB with a 1 MiB stack every route is refused with `RangeError`.

## Tests

- `tests/fixtures/assignment-chain-semantics` on every engine, against native Bun: evaluation and
  setter order right to left for chains of 1, 7, 8, 9, 10 and 17 targets across the inline record
  capacity, all thirteen compound operators and the three logical ones, all nine forms mixed in one
  chain, a chain inside a subscript of a suspended level, arrow, `async` arrow, `yield`, `yield*`
  and destructuring right sides, chained parameter defaults, conditional and comma, strict code,
  ASI, condition and unused-result positions, both second-pass syntax errors, literal, operator,
  call and `new.target` targets, strict `eval` and `arguments` after 1, 9 and 200 levels, missing
  right sides inside arrow defaults and subscripts, module code with a top-level `await` right
  side, script code, a parse after a caught failure, and on JSC the line and column of a write or
  read error JSC raises at levels 1, 9 and 200 of a 200-target chain.
- `tests/fixtures/assignment-chain-depth`: 10,000-target chains through each of the nine forms
  (with resolved names both local and global), in value, ignored-result and condition position,
  in 8-bit and 16-bit sources, all nine mixed, and chains inside nested calls, a conditional branch
  and a lazily generated arrow. A loaded chain must run every setter once; a refused one must be a
  `RangeError` that ran no getter, setter or right side, and the shape must load again at 40
  targets. The JSC embedding gate runs it with `BUNWASM_STACK_EXPECT_CAUGHT=1` on a 1 MiB host stack
  at 192 and 800 KiB, where JSC must accept the source when the function is created and refuse it
  with `Out of memory` at its first call.
- `tests/fixtures/parser-chain-stack` now runs its child at 192 KiB with the default reserve.
- `scripts/jsc-parser-reserve.ts`: all 20 chain rows stay. The strict reserve witnesses are
  conditional chains and blocks. The syntax-check pass of an assignment chain must load the
  deepest chain tried at every tuple and is left out of the strict budget comparison only; the
  full parse's capacity must not move with the parser reserve. Every chain the probe stops must
  stop with `RangeError`, and a shallow chain must parse afterwards (`tests/stack-depth.js` prints
  each chain's boundary).

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, assignment chains](#jsc-assignment-chains-without-parser-recursion) | Port | Parse a chain of assignment targets in one parser activation, and reserve generator stack in the nine assignment emitters. |
| `tests/fixtures/assignment-chain-semantics`, `tests/fixtures/assignment-chain-depth` | Original adapter | Assignment chain semantics and the nine-form depth controls through the guest entry point. |

[Ledger scope and pinned revisions](scope.md).
