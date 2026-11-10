# QuickJS lookahead errors

Class **Upstream bug**. The upstream source is QuickJS-ng 0.16.2 in
rquickjs-sys 0.13.0, imported at `902364cf9`. The local file is
`third_party/rquickjs-sys/quickjs/quickjs.c`.

`js_parse_skip_parens_token` scans ahead, then restores its saved position
through `js_parse_seek_token`, which calls `next_token` one frame deeper than
its caller reads on. That restoration can exhaust the stack and return `-1`
with a pending RangeError. Errors met while scanning are speculative and are
cleared by design; the final `-1` is different: it means the position was not
restored. Ten callers ignored it or compared it with a token. The parser then
read on from a stale token from a shallower frame, and the syntax error it
produced replaced the RangeError.

Two overwrites were observed:

- The function-parameter parser read the opening parenthesis again and reported
  `SyntaxError: missing formal parameter`.
- `js_parse_postfix_expr` looks ahead at `{` and `[` to tell a destructuring
  assignment from a literal. A failed restore compared unequal to `=`, so the
  literal was parsed from a stale token: `SyntaxError: invalid property name`.
  The webpack bundle in Next 15.5.6 hit this at the 36 KiB desktop Safari
  budget. It was traced on the unchanged engine before the callers were
  changed, with a private instrumented build.

Every caller now propagates the exact `-1` before using the scan's result. Real
tokens are negative too, so a generic negative-value check would reject valid
syntax. Each caller keeps its own cleanup: the object-binding caller releases
its property name through `prop_error`, the `for` header caller takes the
statement's failure path with its label atom, and the async-arrow caller
returns before its fallback seek. Callers that tested the scan inside a
condition now run it first under the same token test, so the scan happens in
exactly the cases it did before. No stack budget, guard or error class changes.

| Caller | Lookahead for |
| --- | --- |
| `js_parse_function_decl2` | Parameter defaults and patterns (the first fix) |
| `js_parse_destructuring_element`, three sites | Spread detection, and nested object and array patterns |
| `js_parse_postfix_expr` | Destructuring assignment against a literal (traced) |
| `js_parse_assign_expr2`, two sites | Arrow and async arrow functions |
| `js_parse_var` | Binding patterns |
| `js_parse_for_in_of` | A pattern before `in` or `of` |
| The `for` statement | A `;` in the header |

Only the two overwrites above were reproduced. The other callers had the same
defect in the same helper contract and are corrected with it; nothing here
claims each of them produced a wrong error in practice.

This corrects upstream error propagation, not the WASI stack-guard port.
`tests/fixtures/parser-error-preservation` is an original regression. It parses
valid deep arrow, object-literal and array-literal syntax at several shallow
invocation depths, requires RangeError, checks ordinary invalid syntax remains
SyntaxError, and verifies successful evaluation after each overflow and after
each syntax error. `scripts/check-quickjs-parser-stack.ts` compiles valid source
that reaches every caller at about two thousand stack limits on the bare
engine and accepts only a compile or a RangeError.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `quickjs.c`, callers of `js_parse_skip_parens_token` | Upstream bug | Propagate the failed token restoration before another token read can overwrite its exception. |
| `tests/fixtures/parser-error-preservation` | Original adapter | Exercise error preservation and recovery through the guest entry point. |

[Ledger scope and pinned revisions](scope.md).
