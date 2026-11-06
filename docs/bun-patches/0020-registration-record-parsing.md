## 0020 registration record parsing

File `0020-wasm-parse-registration-records-without-folding-this.patch`. Class **Host feature**. Upstream source is Bun at `9510e74152073d850a18758ca41114d8f214ffa6`, after patches 0001 to 0019: `src/js_parser/lib.rs`, `src/js_parser/p.rs`, `src/js_parser/visit/visit_binary.rs`, `src/js_parser/visit/visit_expr.rs` and `src/js_parser/visit/visit_stmt.rs`.

A [registration record](module-registration-loader.md) runs a module's body inside a strict generator called without a receiver. Bun's parser assumes the body stays a module: it replaces module-level `this` with `undefined` (or `exports`), folds `typeof` of a literal and literal (in)equality, moves an equality's constant operand to the right, and names an anonymous `export default function` after the file. Each of those is right for a module and wrong once the body is a generator: the name, the folds and the reordering change what `Function.prototype.toString`, `.name` and `this` report. A generator also accepts `new.target`, which a module rejects as an early error.

`src/js_parser/lib.rs` adds `with_bunwasm_register_parse`, a thread-local switch with a restore guard, off by default. While it is on:

- `p.rs` `value_for_this` keeps `this` as written, as REPL mode already does.
- `visit_expr.rs` does not fold `typeof` of a literal, and notes the first `new.target` outside every function, class body and static block (`bunwasm_module_new_target`). Whether that is an error depends on the module format, which only the caller knows: bunwasm-transpiler rejects it for an ES module record, while the same parse mode also prepares CommonJS, where it is valid.
- `visit_binary.rs` does not fold `==`, `!=`, `===` or `!==` of literals, does not rewrite `x != void 0`, and keeps both operands of an equality where they were written.
- `visit_stmt.rs` leaves an anonymous default function without the generated name. The registration pass gives it the name `default` the way the language does.

`crates/bunwasm-transpiler` turns the switch on for both passes of a record (source preparation and the record parse) and turns off dead-code elimination, syntax minification and inlining for them. It is never on for ordinary transpiles, `bun build` or the store-backed module path. The private source-only `wasm` commit is `c1482ec047e27a76802d730a3ccd8b69ab5b0738`, tree `0f8eb0625b962daf69cde6dbdef54d5cf6510c0f`, over `bfac42ba` (tree `5a60f408`). Patches 0001 to 0019 export byte-identical.

Tests: `crates/bunwasm-transpiler/src/register.rs` checks module `this`, prepared sources keeping `this` and literals through both passes, anonymous default functions and classes, equality operands in both orders through both passes, module-level and arrow `new.target` as syntax errors with valid nested uses kept, CommonJS preparation keeping `new.target`, and that record parsing does not leak into ordinary transpiles on the same or another thread. The `tests/fixtures/esm-loader` cases `module-this`, `default-names` and `module-arguments` compare the loader with Node, and `web/guest-tests/module-records.ts` runs the same controls on the actual browser guest with and without a module store.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0020](#0020-registration-record-parsing) | Host feature | Keep `this`, literal comparisons, equality operand order and anonymous default functions as written while parsing a registration record, and note module-level `new.target`. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
