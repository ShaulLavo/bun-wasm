# QuickJS parameter lookahead errors

Class **Upstream bug**. The upstream source is QuickJS-ng 0.16.2 in
rquickjs-sys 0.13.0, imported at `902364cf9`. The local file is
`third_party/rquickjs-sys/quickjs/quickjs.c`.

`js_parse_skip_parens_token` restores its saved position through
`js_parse_seek_token`, which calls `next_token`. That restoration can exhaust
the stack and return `-1` with a pending RangeError. The function-parameter
parser ignored the return and called `next_token` again from a shallower
frame. If that call succeeded, it read the opening parenthesis again and
replaced the RangeError with `SyntaxError: missing formal parameter`.

The parameter parser now checks the exact `-1` return before advancing the
token. Valid lookahead tokens are also negative, so a generic negative-value
check would reject valid syntax. Existing cleanup forwards the original error.
No stack budget, guard, or error class changes.

This corrects upstream error propagation, not the WASI stack-guard port.
`tests/fixtures/parser-error-preservation` is an original regression. It parses
valid deep arrow syntax at several shallow invocation depths, requires
RangeError, checks ordinary invalid parameters remain SyntaxError, and verifies
successful evaluation after each overflow and after the syntax error.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `quickjs.c`, function-parameter lookahead | Upstream bug | Propagate the failed token restoration before another token read can overwrite its exception. |
| `tests/fixtures/parser-error-preservation` | Original adapter | Exercise error preservation and recovery through the guest entry point. |

[Ledger scope and pinned revisions](scope.md).
