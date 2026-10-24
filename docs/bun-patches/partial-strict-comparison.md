## Partial strict comparison

Class **Port**. `src/js/partial_assert.ts` adapts the `PartialDeepEqual` rules
in Bun's `src/jsc/modules/NodeUtilTypesModule.cpp` at the revision above.
It retains ordered subsequence comparison, partial object and Map/Set contents,
identity-key reservations and branch-local cycle tracking. TypeScript replaces
JSC cell roots, property slots and typed-array storage access with engine-neutral
objects, iterators and reflection. The existing assertion module supplies
`AssertionError`, argument checks and diff rendering.
Object prototypes are ignored, and boxed primitive slots use `Object.is`.
URL comparisons read the intrinsic href; KeyObjects use the existing private
brand and the public equals method, followed by own-property subset checks.
Typed-array storage and brands come from intrinsics, independently of an own
iterator or toStringTag. DataView and ArrayBuffer numeric own properties remain
part of object comparison. Map identity entries are consumed only after their
values match; a mismatch can fall back to an unconsumed partial key/value match.

Bun's `src/js/node/assert.ts` calls a native JSC function for this comparison,
so loading that module alone cannot supply an engine-independent implementation.
The existing assertion adapter gains the `partialDeepStrictEqual` diff header
from `src/js/internal/assert/assertion_error.ts` at the same revision.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Partial strict comparison](#partial-strict-comparison) | Port | Translate Bun's native partial-comparison rules to TypeScript for all engines. |

[Ledger scope and pinned revisions](scope.md).
