### Bun SQLite

`crates/bunwasm-runtime/src/js/bun_sqlite.ts`. Class **Port**. Upstream `src/js/bun/sqlite.ts` and the behavior implemented by `src/jsc/bindings/sqlite/JSSQLStatement.cpp` at the Bun pin.

Adapt Database/Statement behavior, constants, named-parameter handling, strict mode, query caching, and transaction wrappers. Replace `$cpp` calls and JSC statement objects with numeric handles and `native.sqlite` operations implemented in Rust in `crates/bunwasm-runtime/src/sqlite.rs`. JavaScript shapes values and rows while Rust binds and steps the unmodified SQLite library. This keeps SQLite usable without Bun's C++ engine bindings. The Rust ABI adapter is original code, not a copy of `JSSQLStatement.cpp`.

The transaction controller and wrapper retain code Bun explicitly attributes to Joshua Wise's better-sqlite3 `lib/methods/transaction.js`. The retained upstream revision is Bun's pin. A separate better-sqlite3 import revision is not recorded in that section. Keep BEGIN/COMMIT, nested savepoints, rollback, and the four transaction modes, replacing statement ownership/preparation with the local native-handle model. This is inherited copied implementation, not an original transaction adapter.

The TypeScript conversion preserves the ported executable syntax, strict directive, transaction wrappers, statement identity, and value conversion. No upstream dependency source was changed or re-imported.

Iterator closure resets the live native statement in a `finally` block, including early break, explicit return, and loop-body exceptions. This original Rust reset adapter preserves bindings and execution metadata without finalizing the statement. Finalized, released, and force-closed statements are cleanup no-ops. The adapter ignores SQLite reset's previous-step status so cleanup does not replace the original error.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/bun_sqlite.ts`](#bun-sqlite) | Port | Move Bun's SQLite wrapper and inherited transaction code onto Rust SQLite natives. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
