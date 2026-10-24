## YAML boxed coercion

`crates/bunwasm-runtime/src/js/yaml_coercion.ts` and its calls from `formats.ts`
are **Host feature**, an **original adapter**. Comparison source is Bun
`src/runtime/api/YAMLObject.rs` at pin
`9510e74152073d850a18758ca41114d8f214ffa6`, not copied implementation. The
adapter performs string/number wrapper conversion through user primitive hooks
and ordinary conversion methods, preserving thrown values. It validates an
exotic hook's result before scalar conversion, retains Boolean's internal value,
and applies the same rules to YAML indentation. JSON5 and TOML conversion are
unchanged. This replaces direct `valueOf()` calls that skipped the hook.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [YAML boxed coercion](#yaml-boxed-coercion) | Host feature | Original wrapper conversion preserves user coercion errors and indentation semantics. |

[Ledger scope and pinned revisions](scope.md).
