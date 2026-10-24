## Wasmi memory identity and growth

Class **Port**. `third_party/wasmi` copies the published Wasmi 0.46.0 crate,
upstream `crates/wasmi` at revision `50ac76771d631f642e8c4c61bf44c99546024461`
from `wasmi-labs/wasmi`. The MIT and Apache license files come from that revision.
Cargo uses this local crate through `[patch.crates-io]`; Wasmi Core and its other
dependencies remain published crates.

Local changes are limited to these files:

- `src/memory/mod.rs` derives equality on store-guarded memory handles and exposes
  the growth generation. Successful public growth increments that generation.
- `src/store/inner.rs` owns a generation counter for each allocated memory.
- `src/store/pruned.rs` increments the counter after successful wasm growth.
- `src/engine/translator/visit.rs` and `src/engine/executor/instrs/memory.rs`
  preserve zero-page growth instead of replacing it with a memory-size read.
- `src/engine/translator/tests/op/memory/memory_grow.rs` updates the corresponding
  translation expectation to retain the zero-page growth instruction.

The JavaScript API requires a new buffer after every successful unshared growth,
even when its size stays the same. Tracking growth inside the interpreter covers
both constant and dynamic wasm instructions, as well as JavaScript calls. Failed
growth does not increment the counter. Store-guarded handle equality lets aliased
exports share one JavaScript object without conflating separate empty memories.
All other retained upstream files are unchanged.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Wasmi memory identity and growth](#wasmi-memory-identity-and-growth) | Port | Expose stable memory identity and successful growth, including zero-page growth. |

[Ledger scope and pinned revisions](scope.md).
