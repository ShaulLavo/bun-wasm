# CLI shim program initialization

Class **Host feature**. `web/scripts/run.ts` is an original bun-wasm adapter, not
copied or adapted upstream code. Its previous direct-start path is recorded at
bun-wasm `b3694e32fb48092aabdd1889e44bbc34343e9857`.

The CLI shim uses the existing declared-program loader to load a split core with
its matching engine companion. Waffle's link plan binds memory and runs the core
constructors and companion initialization before command entry. Directly starting
the split core skipped these stages and trapped before user code. This preserves
the shim's filesystem, process ABI, signals, and table or import network slots.
The shim disposes its link group and joins its network helper during teardown.

The CLI regression fixture traps unless its core constructor ran exactly once
and the matching companion registered. It runs through the actual CLI entry for
QuickJS and JSC. Existing generic Preview1 and signal controls remain unchanged.
