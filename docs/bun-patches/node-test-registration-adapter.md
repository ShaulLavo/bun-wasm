## Node test registration adapter

Class **Host feature**. `crates/bunwasm-runtime/src/js/node_test.ts` is an
original adapter over the existing `bun_test` runner. Its optional-name argument
normalization follows behavior observed in native Bun 1.4.2, revision `744846f84`.
No implementation is copied from Bun's `src/js/node/test.ts` at the pinned
`9510e74152073d850a18758ca41114d8f214ffa6`, or from Node.

A function in the first position supplies its own name. An options object before
the function supplies skip, todo and timeout settings. Missing function names use
`<anonymous>`; explicit string names, including the empty string, stay unchanged.
All registration methods use the same normalization. The underlying runner still
owns callback and hook errors; this change adds no options or TestContext behavior.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Node test registration adapter](#node-test-registration-adapter) | Host feature | Original optional-name normalization preserves callback names, explicit names, runner selection and timeout forwarding. |
