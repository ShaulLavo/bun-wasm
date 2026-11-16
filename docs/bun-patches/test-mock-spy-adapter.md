# Mock and spy contracts

Classification: original adapter.

`crates/bunwasm-runtime/src/js/bun_test.js` implements the public mock, spy and
mock-matcher contracts in JavaScript. It follows Bun's test runner API at
upstream revision `9510e74152073d850a18758ca41114d8f214ffa6`, especially the
unchanged `test/js/bun/test/mock-fn.test.js` and
`test/js/bun/test/spyMatchers.test.ts` cases. No upstream implementation is copied.

Mock methods share a prototype above `Function.prototype` and validate their
actual receiver through the private state map. The function methods and engine
diagnostic properties remain inherited. Names, return-value shorthand, the
`lastCall` getter, promise wrapping and temporary implementation queues follow
the observable mock behavior. Temporary implementations isolate their queued
one-shot implementations until the callback completes.

Non-function property spies install one mock as both getter and setter, keeping
the original value until restoration. Restoration preserves existing own data
descriptors, removes shadows of inherited methods, and restores missing value
properties as writable, enumerable and configurable data properties. Existing
accessors and non-callable function `prototype` properties are rejected before
installation.
Failed property installations remove their mock from global restoration before
rethrowing the original error, so a rejected spy cannot block later valid spies.

Call and return matchers validate counts and unexpected arguments before
applying negation. Return counting visits every result, including array holes,
and reports malformed entries as matcher input errors. It preserves incomplete,
returned and thrown result distinctions, including thrown `undefined`.

`scripts/test-mock-spy.test.ts` runs the actual factories against the maintained
`tests/fixtures/test-mock-spy-contract/` contract. The native manifest registers
that fixture for QuickJS, JSC, Browser and SpiderMonkey. The fixture checks
receiver errors, borrowed methods, identities and order, temporary queues,
promise wrapping, indexed spies, restoration and malformed matcher inputs.
