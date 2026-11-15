# SpiderMonkey if statement completion

## Classification

This is an upstream bug fix for Mozilla revision
`a5df22d986d4b626f771b4f8885241941601c35c`. It changes
`js/src/frontend/FoldConstants.cpp` and
`js/src/frontend/BytecodeEmitter.cpp` through
`spidermonkey/spidermonkey-wasi.patch`.

## Changes and reasons

An `if` supplies `undefined` when its chosen arm has an empty completion.
The pinned frontend instead retains a preceding expression result. For example,
`11; if (0) { 12; }` returns `11` from `JS::Evaluate` and from direct and
indirect eval. A dynamic condition has the same defect.

`FoldIf` preserves the completion boundary when replacing a constant `if`
with its chosen arm. A statement list prefixes that replacement with a raw
undefined literal. The raw literal does not read a binding named `undefined`.
The prefix wraps the final root replacement after the existing iterative
else-if fold, so constant branches still disappear.

`BytecodeEmitter::emitIf` initializes the script result to `undefined` before
emitting the condition. It uses the same observable top-level-result predicate
as expression statements. Function returns and scripts with `noScriptRval`
do not receive this initialization. An arm that produces a value overwrites
the initial result. Plain blocks and bare break or continue statements retain
their existing completion behavior.

## Regression coverage

`tests/fixtures/if-completion` asserts constant and dynamic arms, declarations,
else-if chains, labelled breaks, continues, selected-arm values, shadowed
`undefined`, and returns through `finally`. Its native check manifest selects
QuickJS, JSC, Browser and SpiderMonkey through the existing fixture gate.

`crates/bunwasm-spidermonkey/tests/eval-completion.cpp` adds original test code
to the existing engine-semantics control. Each case checks the raw classic-script
result and nested direct and indirect eval. The existing control runner selects
interpreter and portable baseline explicitly. No default tier changes.
