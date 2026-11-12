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

The levels of one chain now run inside one `parseAssignmentExpression` activation. Upstream's
function is cut at its operator loop into two inlined steps:

- `parseAssignmentLevelStart` is upstream's code from the function's entry to its operator loop:
  the entry assertion and stack check, `yield`, the arrow function candidate, the destructuring
  retry and the first operand. Its early returns are unchanged.
- `parseAssignmentLevelOperator` is upstream's operator loop, unchanged except at its call to
  itself. There it suspends the level. A resumed level continues at the statement after that call,
  with the right side, or 0 when it failed, as `lhs`. So a failed right side takes upstream's
  failure check once per level, a level can still reach the operator loop a second time (after an
  arrow or a bare `yield`), and the level reduces its own targets with its own location and counts.
  Upstream's six live locals are references into the level's record.

The driver, `parseAssignmentExpression` itself, keeps the reserve and frame every real call had.
It runs a level; on a suspension it copies the level's record onto
`m_suspendedAssignmentLevels` and starts a fresh level for the right side; when a level completes
or fails it copies its parent's record out and resumes it. Each activation removes exactly the
records it added before it returns, including after a failure, so a nested activation (a
parenthesized expression, an argument, a subscript, a conditional branch) never sees or changes
its caller's records. The vector is a member of the parser with inline room for eight records of
44 bytes, so chains of up to eight targets allocate nothing and no record lives in a parser frame.

Every other route through the function keeps its frames, its reserve and its depth. Bun's
transpiler parses `require`d files first, with its own unguarded recursion; that is unchanged.

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
`RangeError: Maximum call stack size exceeded` when the function was created.

## Consumers of the deeper assignment spine

Checked against the edited source before the first build:

| Consumer | Source |
| --- | --- |
| Builder reduction | `ASTBuilder::createAssignment` pops one stack entry per target; `makeAssignNode` inspects only the target and right side's type tags |
| Constructors and queries | The nine node classes store child pointers. They have no recursive query overrides; `isPure` is the base `false` |
| Condition context | Assignment nodes inherit `ExpressionNode::emitBytecodeInConditionContext`, which goes through guarded `emitNode` |
| Right side | All nine emitters reach the right side only through `emitNode`, directly or through the inlined `emitReadModifyAssignment` and `emitShortCircuitAssignment`. `emitNode` is inlined into each emitter, so one generator level is one emitter frame and one indirect call |
| Teardown | Parser arena nodes have no destructors that recurse; the arena frees pools iteratively |

## Tests

- `tests/fixtures/assignment-chain-semantics` on every engine, against native Bun: evaluation and
  setter order right to left for chains of 1, 7, 8, 9, 10 and 17 targets across the inline record
  capacity, all thirteen compound operators and the three logical ones, all nine forms mixed in one
  chain, a chain inside a subscript of a suspended level, arrow, `async` arrow, `yield`, `yield*`
  and destructuring right sides, chained parameter defaults, conditional and comma, strict code,
  ASI, condition and unused-result positions, both second-pass syntax errors, literal, operator,
  call and `new.target` targets, strict `eval` and `arguments` after 1, 9 and 200 levels, missing
  right sides inside arrow defaults and subscripts, module code with a top-level `await` right
  side, script code, a parse after a caught failure, and on JSC the line and column of a getter or
  setter error at levels 1, 9 and 200 of a 200-target chain.
- `tests/fixtures/assignment-chain-depth`: 10,000-target chains through each of the nine forms
  (with resolved names both local and global), in value, ignored-result and condition position,
  in 8-bit and 16-bit sources, all nine mixed, and chains inside nested calls, a conditional branch
  and a lazily generated arrow. A loaded chain must run every setter once; a refused one must be a
  `RangeError` that ran no getter, setter or right side, and the shape must load again at 40
  targets. The JSC embedding gate runs it with `BUNWASM_STACK_EXPECT_CAUGHT=1` on a 1 MiB host stack
  at 192 and 800 KiB, where JSC must accept the source when the function is created and refuse it
  with `Out of memory` at its first call.
- `tests/fixtures/parser-chain-stack` now runs its child at 192 KiB with the default reserve.
- `scripts/jsc-parser-reserve.ts`: the reserve sites are conditional chains and blocks. The
  syntax-check pass of an assignment chain must load the deepest chain tried at every tuple, and
  the full parse's capacity must not move with the parser reserve.

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, assignment chains](#jsc-assignment-chains-without-parser-recursion) | Port | Parse a chain of assignment targets in one parser activation, and reserve generator stack in the nine assignment emitters. |
| `tests/fixtures/assignment-chain-semantics`, `tests/fixtures/assignment-chain-depth` | Original adapter | Assignment chain semantics and the nine-form depth controls through the guest entry point. |

[Ledger scope and pinned revisions](scope.md).
