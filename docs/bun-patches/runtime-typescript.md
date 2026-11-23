## Runtime TypeScript

Class **Host feature**. `scripts/transpile-runtime.ts`, the runtime embedding build step,
`src/js/runtime.d.ts`, the typecheck configuration and build regression tests are original
bun-wasm adapters. They call the host Node.js `node:module.stripTypeScriptTypes` API in whitespace-preserving
strip mode. No Node implementation is copied. No upstream implementation
is copied or changed. `src/js/glob.ts` and `src/js/bun_builtin_globals.ts` are the existing
original adapters renamed from JavaScript with type annotations. Glob option assembly returns a tuple derived from the positional native contract. The builtin loader adapter
section above records their original role; neither file is an upstream fork.

The host stripper blanks erasable TypeScript during Cargo's build, preserving JavaScript
constructor calls, class fields and source coordinates. The loader still
looks up the same extension-free names. Type erasure leaves existing `.js` sources untouched (minifying, below, is a separate step). No TypeScript parser
or typecheck is added to the wasm runtime.

The same script then minifies every embedded runtime module except `intl.js` and `tz_data.js`
with the host `Bun.Transpiler` (`minifyWhitespace` only: no syntax or identifier minification).
This is an original adapter around that API; no Bun source is copied or changed. It keeps the
`"use strict"` directives Bun would drop and every leading comment that carries a copyright,
license or permission notice. It finds directives with a small lexer for our own modules, not a full
parser, and refuses a parenthesized string statement. It fails the build if a module does not start
with one function or arrow expression that has a block body (the expression is parsed, never run).
`scripts/runtime-emission.test.ts` compares every module's directive prologues before and after
minifying with TypeScript's parser, and checks that no sloppy module declares a function in a nested
block, since Bun's reprint scopes those differently. Existing `.js` sources are minified too, so they
are no longer embedded byte for byte.
It removes about 722 KB raw, 140 KB gzip and 100 KB brotli from each guest.
Shipped stack frames therefore carry positions in the compacted code; `BUNWASM_JS_PRESERVE_POSITIONS=1`
builds the position-preserving form.

A line that held only erased types (an alias, interface or overload) is emptied rather than
left as spaces. Line terminators and every remaining token's line and column are unchanged,
and template text is never erased, so no string content moves. Against `868a0ce8`,
emptying 242 type-only lines in the 35 existing TypeScript modules saves 10,012 emitted
bytes. The JSONL and `node:test` conversions add 603 bytes, for a net emitted reduction
of 9,409 bytes. The converted pair is not counted among those 35 existing modules.

`src/js/jsonl.ts` and `src/js/node_test.ts` were originally the JSONL tokenizer and
`node:test` registration adapter renamed from JavaScript with strict types. Their UTF-8,
data-format and test-runner contracts live in `src/js/runtime.d.ts`. The later
[JSONL token port](jsonl-streaming-tokens.md#jsonl-streaming-tokens) adapts Bun WebKit semantics. The test adapter
does not copy Bun's `node:test` module.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`scripts/transpile-runtime.ts`, runtime TypeScript](#runtime-typescript) | Host feature | Original build adapter and guest types; preserve runtime factory loading. |

[Ledger scope and pinned revisions](scope.md).
