# JSC parser overflow retry

File `Source/JavaScriptCore/parser/Parser.cpp` in `jsc/webkit-wasi.patch`, Bun's
WebKit fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. Class **Upstream bug**.

When `parseAssignmentExpression` fails on an expression that starts with `{` or
`[`, it retries the same source as a destructuring assignment, whatever the
failure was. The retry restores a save point, which clears the "Stack
exhausted" message but leaves `m_hasStackOverflow` set, and then descends to
the stack limit again. Every enclosing literal level repeats both descents, so
the work doubles per level. Each retry through a `(` also appends a
used-variable set that save points do not restore. A literal like
`({a:({a:…0})})` nested 200,000 deep grows memory until an allocation fails,
and WTF's crash helper writes to `0xbbadbeef`. The guest traps instead of
throwing.

The stack check macro `failIfStackOverflow` now also fails when an overflow is
already recorded. Each retry fails at its first check, so every enclosing level
costs constant work and the parse ends with the existing `StackOverflow` parser
error, which eval reports as a catchable `RangeError`. A parse that used to
succeed after a recorded overflow, because a retry happened to need less stack,
now throws that `RangeError`. No budget, reservation or message changes.

This is not specific to WASI: native Bun 1.4.4 shows the same unbounded growth
on the object shape. `tests/fixtures/parser-literal-overflow` is an original
regression. It parses deep object and array literals from 16 stack depths,
requires `RangeError` (QuickJS's separately tracked `invalid property name`
SyntaxError is tolerated only on QuickJS), and checks the parser recovers after
each overflow. The array holds `void 0` so JSC's JSON fast path in eval cannot
bypass the parser.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, parser overflow retry](#jsc-parser-overflow-retry) | Upstream bug | Make a recorded parser stack overflow final, so pattern retries cannot descend again. |
| `tests/fixtures/parser-literal-overflow` | Original adapter | Exercise deep literal overflow and recovery through the guest entry point. |

[Ledger scope and pinned revisions](scope.md).
