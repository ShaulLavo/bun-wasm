# SpiderMonkey suppressed error operands

## Classification

This is an upstream bug fix for Mozilla revision
`a5df22d986d4b626f771b4f8885241941601c35c`. It changes
`js/src/vm/PortableBaselineInterpret.cpp` through
`spidermonkey/spidermonkey-wasi.patch`.

## Changes and reasons

The `CreateSuppressedError` opcode consumes `error, suppressed` and produces
`suppressedError`. The top operand is therefore `suppressed`. The ordinary
interpreter follows that contract, but portable baseline pops `error` first.
A throwing disposer after a throwing body consequently puts the body exception
in `.error` and the disposer exception in `.suppressed`.

Portable baseline now roots the first popped operand as `suppressed` and the
second as `error`. Both values retain their reserved roots across the existing
exit frame and `CreateSuppressedError` call. Allocation failure and the result
push retain their existing paths. No tier selection, stack handling, loop
dispatch, or frontend completion behavior changes.

## Regression coverage

`tests/fixtures/suppressed-error-order` is original test code. It checks original
thrown object identity, both body outcomes, throwing and nonthrowing disposers,
nested multiple disposals, primitive exceptions, and a throwing dispose getter.
Its feature manifest uses the existing native fixture gate.

`crates/bunwasm-spidermonkey/tests/suppressed-error-jsapi.cpp` is an original
direct JSAPI driver. The runtime-owned
`scripts/spidermonkey-suppressed-error.test.ts` compiles and executes that driver
with the same fixture, selecting interpreter and portable baseline explicitly.
It asserts zero PBL entries for interpreter and positive entries for PBL.
It does not load Bun's runtime. Only `console.log` is replaced with a function
that returns the fixture's final success string for the C++ assertion.

The existing statement-spine and completion fixtures remain unchanged.
