## 0021 registration record names

File `0021-wasm-print-registration-names-the-record-allocates.patch`. Class **Host feature**. Upstream source is Bun at `9510e74152073d850a18758ca41114d8f214ffa6`, `src/js_printer/lib.rs`, after patches 0001 to 0020. It changes the registration printing that [0017](0017-module-registration-printing.md) added.

A registration record body refers to the loader's API object (`import.meta`, `import()`) and, for a top-level `for await`, to an iterator and a step result. 0017 printed them as the fixed identifiers `__bunwasm_m`, `__bunwasm_i` and `__bunwasm_r`, which a module could declare or reference itself: a module declaring `const __bunwasm_m` failed to parse, and one reading a global of that name read the loader instead. `with_bunwasm_register` now takes a `BunwasmRegisterNames` with the three identifiers, and the registration printer prints those. bunwasm-transpiler's `register::Names` allocates them, with the record's other added identifiers, so they differ from every name the module declares or references and from any text in its source. Ordinary printing is unchanged, and so is the record printing when no module name collides.

The private source-only `wasm` commit is `2189c7cb2ea736e71a51713f6407b82792d0093a`, tree `de80edc0561ec964e7a37ace1a610e3c0e343c00`, over 0020's `7e862338`. With 0020 it is the whole Bun-group delta over `bfac42ba`: the five parser files and `src/js_printer/lib.rs`.

Tests: `crates/bunwasm-transpiler/src/register.rs` `generated_names_avoid_module_names` covers the API parameter, a namespace binding, the `for await` temporaries, the `arguments` placeholder, a default-export helper and an unbound global reference; `web/guest-tests/module-records.ts` runs the collisions on the actual browser guest.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0021](#0021-registration-record-names) | Host feature | Print the registration record's API and `for await` identifiers the caller allocates instead of fixed names. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
