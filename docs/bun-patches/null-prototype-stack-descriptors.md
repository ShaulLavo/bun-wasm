## Null-prototype stack descriptors

Successful stack values are memoized in an original WeakMap adapter, independently
of the holder's descriptor. Mutable holders may receive a data property;
frozen and sealed holders keep their accessor. Capture rejects non-extensible
or non-configurable targets before native capture mutates them, matching the
Node/V8 public contract. The two runtime-owned `stack` descriptor records are
constructed with null prototypes, so synthetic inherited `get` or `value` fields
cannot change a data descriptor into an accessor or vice versa. This is a local
data-shape correction; the hook operations, receiver identity, and property order
remain unchanged. A single formatting guard covers all errors: reentrant
reads memoize the default stack, successful outer formatters may replace that
value, and throwing formatters clear the guard in finally. These are original
adapters derived from behavior probes, with no Node/V8 implementation copied.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/stack_trace.ts`](#null-prototype-stack-descriptors) | Host feature | Keep the two runtime-owned `stack` descriptor records on null-prototype objects so inherited descriptor fields cannot alter their shape. |

[Ledger scope and pinned revisions](scope.md).
