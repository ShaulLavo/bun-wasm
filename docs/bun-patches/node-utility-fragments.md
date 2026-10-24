### Node utility fragments

`crates/bunwasm-runtime/src/js/util.js`. Class **Port**. Upstream Node `lib/internal/util/parse_args/{parse_args,utils}.js`, `lib/internal/util/comparisons.js`, `lib/internal/util.js`, and `lib/util.js` at the Node comparison revision. Also compare Bun `src/js/node/util.ts` and inspection tables in `src/js/internal/util/inspect.js` at the Bun pin. The direct Node import revision is not recorded.

Adapt parse-argument tokenization, own-property option lookup, short-option groups, strict validation, defaults, and negative options. Replace internal errors and primordials with local helpers and Bun's messages and token names. Retain comparison helper structure and memo conventions, inheritance and promisification fragments, and inspection option/color/style tables. Replace native type checks with intrinsic brand checks and engine hooks. Formatting delegates to the separate inspection port. Bun's deep-equality variant and the surrounding module wiring are local implementations, not copies of Node's whole utility module.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/util.js`](#node-utility-fragments) | Port | Adapt argument parsing, comparison helpers, and inspection tables. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
