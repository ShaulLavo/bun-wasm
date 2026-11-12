# Bootstrap error reporting

Class **Host feature**, **original adapter** in
`crates/bunwasm-engine-quickjs/src/program.rs`. No upstream code is copied or
patched. This shared source is also compiled by the JSC side.

The bootstrap failure path reads an engine-branded error's `name`, `message`
and `stack` through the existing `Engine` operations. Plain-data conversion
enumerates object fields and can omit these diagnostic properties. Stack text
that already starts with the error header is retained without repeating it.
Other thrown values keep the existing plain-data debug representation. A
throwing property getter does not replace the original exception.

The process still returns 70 before entry execution. The engine trait, host
interface, bootstrap operation and memory and stack policy are unchanged.
`scripts/bootstrap-error-reporting.test.ts` compiles the production reporting
and entry-dispatch functions with a dependency-free control engine. It checks
message and stack retention, throwing getters, non-error values, and exit 70
without invoking entry handlers. It does not execute a guest or native engine.
