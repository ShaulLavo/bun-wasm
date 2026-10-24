## Runtime exit provenance

Class **Host feature**, **original adapter** in `src/js/exit_provenance.ts`, with
lifecycle hooks in `bootstrap.js` and `process.js`. No upstream implementation is
copied, so there is no upstream source path or revision.

`BUN_WASM_TRACE_EXIT=1` emits JSON to stderr at explicit exits, fatal errors and
loop completion. Each record contains the guest code, exit reason, JS stack,
refed timers, immediates, ticks, pending I/O, message-port references and network
handle count. The app matrix records the host code and signal separately, along
with timeouts and harness termination. Normal runtime output is unchanged when
the flag is absent.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`src/js/exit_provenance.ts` and lifecycle hooks](#runtime-exit-provenance) | Host feature | Original opt-in exit diagnostics over the existing event loop and error handlers. |
