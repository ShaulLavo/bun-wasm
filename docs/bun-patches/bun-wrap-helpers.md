## Bun wrap helpers

Class **Host feature**. `scripts/generate-bun-wrap.ts` and the embedding hook
wrap `vendor/bun/src/runtime.js` from the same Bun revision in a factory.
The generated body removes `export var` and returns those exported bindings.
The helper implementations are unmodified Bun source, including decorator
metadata, initializer order, accessors and private fields. No generated
JavaScript is checked in. The builtin registry loads this factory as `bun:wrap`.
The generator and registry wiring are original bun-wasm adapters.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Generated `bun:wrap` helpers](#bun-wrap-helpers) | Host feature | Load Bun's unmodified runtime helpers through the builtin registry. |

[Ledger scope and pinned revisions](scope.md).
