# JSC block and `if` nests emitted in one generator loop

Files `parser/Nodes.h`, `parser/NodeConstructors.h`, `parser/Nodes.cpp`,
`bytecompiler/BytecodeGenerator.h`, `bytecompiler/BytecodeGenerator.cpp` and
`bytecompiler/NodesCodegen.cpp` under `Source/JavaScriptCore` in `jsc/webkit-wasi.patch`, Bun's
WebKit fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. Class **Port**. These are the patch's
last six sections; each applies on top of the earlier sections for the same file.

## The problem

The code generator emits a block by calling the emitter of each statement in it, and an `if` by
calling the emitter of each branch. A nest of blocks and `if` statements therefore costs several
host frames per level, and the only guard, `isSafeToRecurse` in `emitNodeInTailPosition`, sees
shadow frames only. Today the parser's statement reserve refuses a nest long before the generator
runs out of host stack. The parser change that lets Next's 80-level `if` spine load (the next
unit of this work) removes that bound for blocks and `if`s, so the generator must stop spending
host stack per level first.

Two pre-emission queries, `hasCompletionValue` and `hasEarlyBreakOrContinue`, also recurse: a
block asks its statements, and a label asks its statement. In program and eval code a run of
directly nested blocks was walked again at every level.

## The change

**Stored answers.** `BlockNode` and `LabelNode` compute both answers once, in their constructors,
and the queries return the stored bits. A block's statement list is finished when the block is
built (`ASTBuilder::createBlockStatement` is the only constructor call, and the parser passes a
list it no longer appends to), and a label's statement is fixed by its constructor, so the answers
cannot change. A child is asked once and answers from its own bits, so building costs one pass over
a block's direct statements and nothing recurses. `SourceElements`, `ScopeNode` and every caller of
the queries are unchanged. The work moves from code generation to AST construction; the
syntax-check pass builds no nodes and pays nothing. The emitter checks in debug builds that a
block's stored answers equal its list's (one level, since children answer from their bits).

**The generator loop.** `BlockNode::emitBytecode` and `IfElseNode::emitBytecode` call
`BytecodeGenerator::emitStatementSpine`. It notes the size of `m_statementSpine`, a vector of
generator-owned records, and runs until the vector is back at that base. A child that is a block or
an `if` gets a record; any other child is emitted natively through `emitNodeInTailPosition` and may
start a fresh activation above the base. Every emit call happens in the order the recursive
emitters made it:

| Step | Does |
| --- | --- |
| Open a block | Return if it has no statements. Secure room for one record, else refuse. `pushLexicalScope`, the first half of its `using` scope when it has `using` declarations, the completion-value pre-pass, push the record |
| Next statement | The undefined load before the last statement with a completion value, then the child into the destination or the ignored result, as `SourceElements::emitBytecode` did |
| Close a block | The second half of its `using` scope, `popLexicalScope`, pop |
| Open an `if` | Secure room for one record, else refuse. The early-break load, three labels, the break and continue fold, the condition, `beforeThen` and its profile hook, push the record with the then branch pending (none when folded) |
| After the then branch | The jump over the else when the branch was emitted and an else exists, `beforeElse`, then the else's profile hook with the else pending, or the close |
| Close an `if` | `afterElse`, its profile hook, pop |

Opening a block and opening an `if` are out-of-line helpers (`openStatementSpineBlock`,
`openStatementSpineIf`): they return before any child is emitted, so their locals never stay on the
host stack under a native child. The loop itself keeps a small frame.

Every entered `if` owns one record, folded or not. Its record holds `beforeElse` and `afterElse`
until they are bound; `beforeThen` is bound before the record is pushed. A record also holds the
caller's destination register, as the recursive frames did; the loop adds no temporary owner. No
reference to a record is held across a push or a native emit.

**`using` blocks.** `emitUsingBodyScope` is cut at its body call into `beginUsingBodyScope` and
`endUsingBodyScope`, both out of line. The four values that crossed the body in native locals (the
thrown-value register, the finally label, the `FinallyContext` and the try data) move into the
scope's `UsingScope` entry. `m_usingScopeStack` is a `SegmentedVector`, so the entry and the
context constructed in place in it never move while break, continue and return emitters point at
the context. The first half ends at the old body call and the second half starts there, so every
emit, temporary, label, try and scope call keeps its order; the four values are released when the
entry is removed instead of at the function's return, with no allocation in between.
`emitUsingBodyScope` is `begin; body; end` for its eight other callers (`for`, `for…of`, `switch`
and the program, eval and function bodies). A block reaches the generator through the loop only.

**Refusal.** If a record cannot be allocated the child is skipped with
`emitThrowExpressionTooDeepException`, as when `emitNodeInTailPosition` refuses a child: nothing was
opened, every enclosing record still closes, and `generate` returns `OutOfMemory`, a `RangeError`.
`generate` asserts in debug builds that the spine and `using` stacks are empty.

## Evidence

- Bytecode: `JSC_dumpGeneratedBytecodes` reaches the guest. The semantics fixture's full dump
  (474 code blocks, the runtime's own included) is identical before and after, except the print
  order of string `switch` tables, whose hash map mixes in its own address
  (`RobinHoodHashTable::computeTableHash`); the entries are the same. Two baseline runs give
  identical dumps.
- `tests/fixtures/statement-spine-semantics` matches native Bun on the baseline and on the change.
- Capacities, before and after, from one guest process per attempt: blocks, `if`s, `else if`
  chains, labels, `using` blocks, braced `for`, `while`, `do`, `try`, `switch` and `with` nests,
  function expressions in `if` blocks and unbraced `while` nests, in function and program code. At
  192, 208 and 800 KiB, 208 KiB with the 960 reserve, and 192 KiB with reserves 1024 and 512,
  every row is equal except `else if` chains, which the generator refused at about 2,300 links and
  now emits at the probe's 4,096. With the guest guard out of the way on 256 and 512 KiB Wasmtime
  host stacks, every row traps at the same depth as before except `else if` chains, which trapped
  at 1,225 and 2,485 links and now complete 4,096. `scripts/measure-stack.py`'s modes are equal.
- Refusal: a development build that refuses the record past a chosen depth gives `RangeError`
  `Out of memory` with no code run when the refused record is a `using` block, a plain block, an
  `if`, a folded `if` or an else branch under three open `using` blocks, sync and async, and the
  guest compiles and runs a shallow `using` block afterwards.
- Size: `BlockNode` and `LabelNode` grow by 4 bytes each on wasm32 (112 to 116, 40 to 44).
- Code: `BlockNode::emitBytecode` and `IfElseNode::emitBytecode` are five-instruction calls to the
  loop, which calls neither `emitUsingBodyScope` nor `emitBodyWithUsingIfNeeded`. The loop's shadow
  frame is 48 bytes with 34 locals; the block emitter it replaces on every native child's path was
  32 bytes and 9 locals plus `SourceElements::emitBytecode`. The interpreter frame gate is
  unchanged (4,896 bytes, 293 of 328 slots).

## Fixtures

- `tests/fixtures/statement-spine-semantics`: completion values through direct and indirect eval
  and function code, folded `break` and `continue` with and without `else` and under outer
  records, a folded then branch before a deep else, abrupt completion through `finally`, tail
  position returns, and `using` and `await using` blocks: disposal order, throw, return, `break`,
  `continue`, labelled exits across levels, a generator ended early, disposal failures and
  `SuppressedError` chains, folding inside `using` blocks, mixed `if` and `using` trees, `using`
  in `try`, `catch`, `finally`, `for…of` and `for`, placement checks, and long label runs followed
  by a later syntax error.

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, statement spine](#jsc-block-and-if-nests-emitted-in-one-generator-loop) | Port | Store block and label completion answers when built; emit nests of blocks and `if`s, including `using` blocks, in one generator loop. |
| `tests/fixtures/statement-spine-semantics` | Original adapter | Block, `if` and `using` semantics through the guest entry point. |

[Ledger scope and pinned revisions](scope.md).
