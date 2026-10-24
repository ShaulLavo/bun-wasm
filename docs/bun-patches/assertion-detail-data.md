## AssertionError detail records

`crates/bunwasm-runtime/src/js/assert.ts` ports the numbered detail-property
assignments from Bun `src/js/internal/assert/assertion_error.ts` at
`9510e74152073d850a18758ca41114d8f214ffa6`. Bun carries Node's assertion code;
the direct historical Node import revision is unrecorded. This is the data-only
part of original PR129, not its CallTracker implementation.

The exported `assert.AssertionError` constructor now writes one ordered group of
`message N`, `actual N`, `expected N`, `operator N`, and `stack trace N` properties
for each supplied detail. An empty details array selects this mode without
creating ordinary summary properties. Values and stack objects keep their
identity. The local helper keeps the upstream numeric iteration and property order.
Ordinary assertions retain their existing assignments and input-read order. No CallTracker, async context, HTTP, subprocess, IPC or Worker behavior
changes.

The original declaration extension admits readonly detail arrays and raw unknown
field values. The optional operator declaration describes the constructor's
existing no-operator behavior. Converting that optional operator to a property
key with `String` preserves JavaScript's existing key coercion.

The existing AST/position test reverses only the detail helper, constructor
branch and explicit key conversion before comparing with its unchanged original
AST pin. Original emitted-factory tests exercise the public constructor and
ordinary assertion controls. These are host-side synthetic checks, not guest or
JSC acceptance. PR165's worker-error fallback remains a separate dependency of
the held PR128 work and is not imported here.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `assert.ts` detail-property assignments | Port | Adapt Bun's numbered AssertionError data groups to the typed local constructor. |
| `assert_util_types.d.ts` | Host feature | Original readonly detail-data and optional-operator contracts. |
| `scripts/runtime-assertion-details.test.ts`, `scripts/runtime-assert-util.test.ts`, `checks/runtime-assertion-details.json` | Host feature | Original emitted-factory controls, strict type checks and exactly-once runtime discovery. |

[Existing assertion port](node-assertions.md).

[Ledger scope and pinned revisions](scope.md).
