# SpiderMonkey parser recursion frames

This port patches Mozilla revision `a5df22d986d4b626f771b4f8885241941601c35c` through
`spidermonkey/spidermonkey-wasi.patch`. Every change is guarded by `__wasi__ && BUNWASM_EMBED`;
other builds keep the original code.

| Upstream path | Classification | Local change and reason |
| --- | --- | --- |
| `js/src/frontend/Parser.h`, `GeneralParser` declarations | Port | `BUNWASM_PARSER_MERGED` (`MOZ_ALWAYS_INLINE`) on the in-class declarations of `statementListItem`, `blockStatement`, `consequentOrAlternative`, `optionalExpr`, `primaryExpr`, `exprInParens`, `orExpr` and `condExpr`, and a never-inline `unbracedFunctionConsequent`. |
| `js/src/frontend/Parser.cpp`, the same members' definitions | Port | The same attribute on the definitions (`orExpr` and `condExpr` were already always-inline there). |
| `js/src/frontend/Parser.cpp`, `consequentOrAlternative` | Port | A braced body goes to `blockStatement` directly. It holds and checks the recursion unit `statement` would hold, before consuming the `{`, then consumes it as `statement` does. The Annex B branch (an unbraced function declaration under `if`) moves unchanged into `unbracedFunctionConsequent`, so its statement and scope objects stay out of `ifStatement`'s merged frame. |

## Why

A wasm host stack pays one frame for every C++ function in a recursion cycle, and a cold
WebKit frame costs 0.6 to 0.9 KiB whatever it holds. SpiderMonkey's parser spends many small
functions per nesting level: six for a braced `if`, three for a block, six to eight for a
parenthesised expression. Ajv's deepest Angular validator (`validate16`, 57 nested `if` blocks)
trapped in the parser in six of seven real-guest attempts on Mac WebKit's portable baseline tier.

Merging those functions into their callers leaves two frames per braced `if` level
(`statementList`, `ifStatement`), one per block (`statementList`), and four per expression level
(`assignExpr`, `unaryExpr`, `memberExpr`, `expr`) in both parsers. The attribute must be on the
in-class declaration: on the definitions alone, the full parser kept every function separate.
The parsing algorithm, node construction, token reads, errors and positions are unchanged. The
braced fast path keeps three recursion units per braced `if` level, so PR 772's 1300-unit compile
bound and its entry-depth and function weights accept and refuse at the same depths.

## Checks

- `scripts/spidermonkey-parser-frames.ts` reads the name section and call graph of a linked
  module. For each of the four instantiations (full and syntax parser, UTF-8 and two-byte) it
  requires the merged members to be gone and the surviving cycle edges to exist.
  `scripts/spidermonkey-parser.test.ts` runs it on the smoke and the ordinary engine side; main's
  library fails it.
- The same test runs a differential corpus (`scripts/spidermonkey-parser-semantics.ts`) through
  the smoke on both tiers: 86 sources, each compiled directly as UTF-8 (script, and an inner
  function called once) and as two-byte strings through `eval`, a lazy inner function and
  `Function`, with ASCII, Latin-1 and non-Latin-1 text before it. It records values, error names,
  messages, files, lines, columns and stacks, then the exact compile-limit boundaries of blocks,
  braced `if` and `else`, labels and nested functions under both parsers, the refusal at one
  level deeper and recovery. `tests/spidermonkey-parser/expected-*.txt` were generated from
  main's library; the merged library gives byte-identical output.

## Effect

Measured November 14, 2026. Fixed-depth acceptance: each depth compiled in three of three fresh
workers of Playwright WebKit 26.6 on the M1 Mac, WebKit 27.2 under `ulimit -s 512`, Chromium 156
and Firefox 157, on both tiers.

| Shape | Lazy | Emit and delazify |
| --- | ---: | ---: |
| Ajv-like validator | 160 | 145 |
| Braced `if` | 220 | 150 |
| Parentheses | 110 | 110 |

Observed sweeps (single runs, interpreter tier), main then this change:

| Shape, phase | Mac WebKit | Linux WebKit, 512 KiB |
| --- | --- | --- |
| validator, lazy | 71, 187 | 92, 240 |
| validator, delazify | 69, 172 | 90, 217 |
| braced `if`, lazy | 103, 231 | 118, 277 |
| block, lazy | 212, 494 | 219, 567 |
| parentheses, emit | 75, 124 | 85, 157 |
| function expression, lazy | 53, 64 | 52, 61 |

After the merge the bytecode emitter, not the parser, is the deepest pass for braced statements
that are compiled in full. Chromium and Firefox stop every shape at the counter bound with a
caught `RangeError`, at the same depth before and after. Chains of assignments (`a = a = ...`)
lose about 4 percent in the full parser on Linux WebKit (431 to 440 levels before, 412 to 424
after, four runs each), because the merged full-parser `assignExpr` grew from 31 to 35 wasm
slots; on the Mac the emitter binds them at 351 before and after.

`validate16` in the smoke needs a 256 KiB Linux WebKit worker stack instead of 400 KiB; Next's
webpack `bundle5.js` needs 272 KiB before and after. In the real guest on Mac WebKit,
`validate16` now compiles on the portable baseline tier, where it trapped before; see
[stack limits](../stack-limits.md#spidermonkey-parser-frames).

The smoke and the engine side each grow by about 24 KB (0.24 percent). Compiling Next's
2.5 MB `bundle5.js` with `new Function` in the guest took a median 180 ms before and after
(native launcher, pinned, interleaved, five rounds per build and tier).

## Original adapters

`crates/bunwasm-spidermonkey/cpp/shim.cpp` adds `bsm_set_global` and `bsm_print` to the
standalone smoke shim, and `examples/smoke.rs` adds the `BUNSM_PARSER_CORPUS` mode that drives the
corpus. Both are bun-wasm source used only by the standalone probe.
