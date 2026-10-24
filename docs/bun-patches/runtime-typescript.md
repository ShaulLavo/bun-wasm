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
looks up the same extension-free names. Existing `.js` sources remain raw. No TypeScript parser
or typecheck is added to the wasm runtime.

A line that held only erased types (an alias, interface or overload) is emptied rather than
left as spaces. Line terminators and every remaining token's line and column are unchanged,
and template text is never erased, so no string content moves. Against `868a0ce8`,
emptying 242 type-only lines in the 35 existing TypeScript modules saves 10,012 emitted
bytes. The JSONL and `node:test` conversions add 603 bytes, for a net emitted reduction
of 9,409 bytes. The converted pair is not counted among those 35 existing modules.

`src/js/jsonl.ts` and `src/js/node_test.ts` are the existing original JSONL tokenizer and
`node:test` registration adapter renamed from JavaScript with strict types. Their UTF-8,
data-format and test-runner contracts live in `src/js/runtime.d.ts`. Neither copies Bun's
C++ JSONL binding or Bun's `node:test` module.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`scripts/transpile-runtime.ts`, runtime TypeScript](#runtime-typescript) | Host feature | Original build adapter and guest types; preserve runtime factory loading. |

[Ledger scope and pinned revisions](scope.md).
