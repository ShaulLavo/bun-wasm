# JSC block and `if` nests parsed on records

Files `parser/Parser.cpp` and `parser/Parser.h` under `Source/JavaScriptCore` in
`jsc/webkit-wasi.patch`, Bun's WebKit fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. Class
**Port**. These sections apply after the patch's earlier sections for the same files, and after
[the code generator's loop](jsc-statement-spine.md), which this change depends on.

## The problem

`parseStatement` parses a block by calling `parseBlockStatement`, which calls
`parseSourceElements`, `parseStatementListItem` and `parseStatement` again for each statement in
it, and it parses an `if` by calling `parseIfStatement`, which calls `parseStatement` for each
branch. Each level costs several host frames and one 2048-byte parser reservation, so the guard
refuses a nest of about 90 blocks or 48 `if` blocks at 192 KiB. Next 15.5.6's
`dist/compiled/webpack/bundle5.js` nests 80 `if` statements with block bodies, so it failed to
load at 192 KiB on every host ([Stack overflow in wasm](../stack-limits.md)).

## The change

`parseStatement` stays upstream's function. Its `{` and `if` cases call `parseStatementNest`
where upstream called `parseBlockStatement` and `parseIfStatement`. `parseIfStatement` is
removed. `parseBlockStatement` stays for its other callers: `try`, `catch`, `finally` and class
static blocks.

`parseStatementNest` is one out-of-line activation per nest. Open blocks and `if`s are records on
`m_statementRecords`; the `else if` chains of open `if`s use `m_ifClauses` and `m_ifBranches`,
upstream's two chain vectors, shared with the records' saved bases. Inside a nest:

| Next token | Parsed by |
| --- | --- |
| `{` or `if` | A record opens. The driver makes `parseStatement`'s entry first (depth, sticky stack check, the Annex B flag) without its frame |
| A declaration list item (`const`, `let`, `class`, `function`, an escaped keyword, an identifier, `await`, `yield`) in a block | `parseStatementListItem`, as upstream's list did |
| Anything else | `parseStatement`, with the reserve and stack check of the frame upstream had for that statement |

So a route that opens no block or `if` keeps upstream's frames and reservations exactly, and a nest
that passes through another statement per level (a braced loop, `switch`, `with`, `try` or a
label) holds `parseStatement`'s reservation per level as before, plus one small driver frame in
place of `parseBlockStatement` and `parseSourceElements`.

Every side effect of the replaced frames happens at the same point in the token stream: scope push
and `preventVarDeclarations` (none for a function body's block at depth 0), the switch-case flag,
statement depth, start and end offsets, pause locations, the `else` token locations and end
offsets of folded `else if` chains, and the Annex B permission set before each branch.

Records hold values only (`StatementRecord` is trivially copyable); no reference to one survives a
push or a nested parse. Tree handles are stored as `uintptr_t` because `ASTBuilder` uses node
pointers and `SyntaxChecker` uses ints, and a `SyntaxChecker` parse runs inside an `ASTBuilder`
parse on the same parser.

**Limit and refusal.** At most 10,000 records are open in one parse, the bound QuickJS's statement
parser uses. A record past the limit, and a failed allocation of any of the three vectors, take
`failWithStackOverflow`: the caller gets today's `RangeError` "Maximum call stack size exceeded."
The record is secured before the scope, the switch flag or the token change it would own.

**Unwind.** `StatementRecordScope` restores the activation's three vectors on every return. On
failure it pops, innermost first, a block's scope (native callees pop their own scopes before they
return, so it is the current one), then its switch flag, then the depth; an `if` restores the
depth. That is the order the replaced frames' destructors ran in. On success the records are
already gone and the block's environment has moved to its node.

## Evidence

From a local split build against current main's side with the same core:

- **Payoff:** `bundle5.js` (sha256 `4f227eea…445b2c`) loads alone through `require` at 176 and
  192 KiB with the default reserve. Before, it threw `RangeError` at both.
- **Bytecode:** the semantics fixture's full `JSC_dumpGeneratedBytecodes` output matches the
  baseline (string `switch` tables differ only in print order).
- **Syntax errors:** class, message, line and column are identical to the baseline for 63 rows of
  blocks, `if` spines, `else if` chains, unclosed blocks and missing branches at depths 1, 9 and
  300, in function, script and module code and both source widths.
- **Records:** `tests/fixtures/statement-record-cap` checks the limit exactly in the JSC embedding
  gate (below). In eval code a nest of 10,000 blocks, bare `if`s or both runs and 10,001 is
  refused. A function or arrow body accepts 10,000 levels when it is built but refuses them on its
  first call, which parses the body again as one more block record, and refuses 10,001 levels
  while building.
- **Fault injection** (a development-only build with release assertions; never shipped):
  - Failing the actual growth of each vector at a real growth step (records past 32, `else if`
    clauses or branches past 16) gives the parser's `RangeError` before any code runs. This holds
    under open lexical scopes, in a second activation entered through a label, in an arrow body,
    and in an `else if` chain whose bases sit above an outer chain's entries. Later scoped parses
    are correct.
  - The earlier refusal cases (record limit under scopes, a switch block, nested chains) still
    unwind cleanly when their vector instead fails at its first growth step.
  - The same build with the record limit removed, or moved to 9,999 or 10,001, fails the exact
    gate on every row. At 10,000 it passes.
- **Debug assertions:** that build turns the new assertions into release assertions: the record
  scope's bases, records left only on an error, the token at each opener, and the generator's
  checks (see [the code generator's loop](jsc-statement-spine.md)). Every fixture and probe above
  ran on it without one firing.
- **Capacities:** blocks, `if`s, `else if` chains and `using` blocks reach the probe's 4,096 at
  192, 208 and 800 KiB, at reserves 512, 960 and 1024, and on Wasmtime 256 and 512 KiB and V8
  1 MiB host stacks with the guard out of the way. Unbraced `while` and `try` nests keep the
  baseline's capacity under the guard and on every host. Braced loop, `switch` and `with` nests
  are 8 to 13% deeper under the guard at the default reserve and 17 to 36% deeper at 1024 to 512,
  because two of upstream's six frames per level are gone; on every host they run out of stack
  later than before (for example `for` 154 to 258 levels on a 256 KiB Wasmtime stack). Every
  remaining host trap is in the parser, not the code generator.
- **Code:** `parseStatement` is upstream's in all four instantiations (857 against 858 wasm
  instructions, same locals and 48-byte frame). `parseStatementNest` has 6 locals and a 32-byte
  frame, against `parseBlockStatement`'s 14 and 48 plus `parseSourceElements`' 26 and 96.
- **Gate:** `scripts/jsc-parser-reserve.ts controls` passes. The unbraced `while` nest witnesses
  the statement reserve (112, 216 and 399 levels at 2048, 1024 and 512 at 192 KiB); block nests
  must load the deepest nest tried at every setting, so the baseline now fails the gate.

## Fixtures and checks

- `tests/fixtures/statement-records-semantics`: every list item form as the first item of a nested
  block, function declarations as branches in sloppy and strict code and under a label, dangling
  `else`, `else if` chains of 1 to 2,000 links, `using` placement under 300 blocks, closures at
  depth 300, list ends at `case`, `default` and end of input, syntax errors at depth, and deep
  nests to 10,000 under one outcome rule (run, or refuse with `RangeError` before any code runs).
- `tests/fixtures/statement-record-cap`: the record limit for eval code (blocks, bare `if`s, both
  mixed, direct eval), function bodies (blocks and bare `if`s) and an arrow body, in both source
  widths, at the last accepted and first refused count, with a first-statement marker and a
  shallow recovery. Every engine prints the same lines. With `BUNWASM_STATEMENT_RECORDS_EXACT=1`,
  which `scripts/jsc-embedding.ts` sets at 192 KiB, JSC must accept and run the last counted
  record and refuse the next one in the stated phase with "Maximum call stack size exceeded." and
  nothing run. Nine built-in negative controls (a removed cap, a cap moved either way, an
  uncounted body block or build pass, another error, a generator refusal, code run before the
  refusal, no recovery) run on every engine and must all be rejected.
- `tests/fixtures/statement-records-async-using`: nests of 300 `await using` blocks in both source
  widths, for normal order, a throw, a return, a labelled break and every disposer rejecting,
  each compared with the same 300 declarations in one flat block. Then a nest past the record
  limit, which must be refused before acquiring anything (exactly so on JSC), and a shallow
  recovery. The depth is a deliberate bound: compiling nested `await using` grows much faster
  than linearly in JSC itself (native Bun takes about 75 seconds at 1,000 levels against 4.3 for
  the flat equivalent). Nothing is claimed about deeper async nests.
- `tests/stack-depth.js`, `scripts/stack-measurement.ts`, `scripts/measure-stack.py`: a `While`
  chain (`while (0) ` repeated) joins the parser chains and replaces blocks as the statement
  reserve witness. Block chains join the chains that load every depth tried.

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, statement records](#jsc-block-and-if-nests-parsed-on-records) | Port | Parse nests of blocks and `if`s in one out-of-line activation on parser-owned records, with a 10,000-record bound. |
| `tests/fixtures/statement-records-semantics` | Original adapter | Block and `if` parsing semantics and deep nests through the guest entry point. |
| `tests/fixtures/statement-record-cap`, `tests/fixtures/statement-records-async-using` | Original adapter | The exact record limit, and bounded deep `await using` nests against their flat equivalents. |

[Ledger scope and pinned revisions](scope.md).
