### Node utility fragments

`crates/bunwasm-runtime/src/js/util.ts`. Class **Port**. Upstream Node `lib/internal/util/parse_args/{parse_args,utils}.js`, `lib/internal/util/comparisons.js`, `lib/internal/util.js`, and `lib/util.js` at the Node comparison revision. Also compare Bun `src/js/node/util.ts` and inspection tables in `src/js/internal/util/inspect.js` at the Bun pin. The direct Node import revision is not recorded.

Adapt parse-argument tokenization, own-property option lookup, short-option groups, strict validation, defaults, and negative options. Replace internal errors and primordials with local helpers and Bun's messages and token names. Retain comparison helper structure and memo conventions, inheritance and promisification fragments, and inspection option/color/style tables. Replace native type checks with intrinsic brand checks and engine hooks. Formatting delegates to the separate inspection port. Bun's deep-equality variant and the surrounding module wiring are local implementations, not copies of Node's whole utility module.

The strict TypeScript migration models raw parser arguments, positional and option values, token names and raw names as unknown. The existing parser does not validate every argument element. It can return nonstrings and can throw at the original property or method operation. Narrow erased views at those exact operations preserve that behavior without validation, coercion, cached reads or a changed receiver. Raw methods return unknown, including `slice` and `indexOf`. [`runtime-util-raw-operations.json`](../runtime-util-raw-operations.json) enumerates all 47 parser assertions, including the two retained preexisting boundaries. Numeric operand views describe attempted JavaScript comparisons, subtraction or addition, not proof that a getter or method returned a number. Property-key views leave the original coercion at each property operation.

Two typed destination extractions replace concat-overload casts. The constructor Set lookup remains before the constructor array, including its second Set lookup. Enumerable string keys are captured before concat lookup and Symbol enumeration. The AST gate reverses only those two explicit extraction shapes and then checks the unchanged approved original hash, including strict directives. Executable controls compare lookup/call order, receivers, identities and per-event thrown-error identity. Reordering mutations must fail. Every emitted token still maps to its actual TypeScript line and column. Comparison dispatch overloads and guarded intrinsic brand checks remain unchanged.

`types.isAsyncFunction` and `types.isGeneratorFunction` keep the brand test on the function's prototype and then reject a function whose source is exactly the engine's native-function placeholder (`function () { [native code] }`), which is what a bound or host function prints. Bun's native check never looks at source text; this is an original adapter, and `tests/fixtures/util-function-types` covers bound functions and source that only ends with the same comment.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/util.ts`](#node-utility-fragments) | Port | Adapt argument parsing, comparison helpers, and inspection tables. |
| [`runtime-util-raw-operations.json`](../runtime-util-raw-operations.json) | Host feature | Original manifest pinning every raw-boundary assertion and its classification. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
