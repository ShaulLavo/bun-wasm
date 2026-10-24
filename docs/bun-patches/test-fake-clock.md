## Test fake clock

Class **Host feature**, **original adapter** in `crates/bunwasm-runtime/src/js/fake_timers.ts`,
with routing in `bootstrap.js`, `bun_test.js`, `process.js` and `web.js`.
No upstream implementation is copied. The reference contracts are Bun's
`src/runtime/test_runner/timers/FakeTimers.rs` and
`src/jsc/bindings/JSMockFunction.cpp` at `cd95fa7a13b3f13be73e512b38ec111c1c228084`.

Bun's implementation calls its JSC global object, native timer heap and virtual machine.
Those cannot run through the portable builtin loader. The adapter keeps fake timer handles
in a separate queue, advances a nanosecond clock, and exposes the controls through `jest`
and `vi`. Global timers and `node:timers` share scheduling and cancellation. Runtime-owned
callbacks use the real timer interface, so filesystem, worker, crypto, compression, readline, and subprocess
work survives fake-clock restoration. Host wakeups use the captured native clock. Timers
created before fake-clock activation keep their real ownership. A separate running-callback
stack keeps numeric handles discoverable during nested drains. Cancellation and `clearAllTimers`
close those running handles without including them in the pending timer count.

A stable Date constructor wrapper preserves references saved before activation, explicit
constructor arguments, subclasses and Date instances. Its current time also supplies native
Intl formatters when callers omit the date. `setSystemTime` rebases wall time without changing
timer deadlines. Performance and process high-resolution time use the fake monotonic clock.
`runOnlyPendingTimers` uses Bun's latest pending deadline as its horizon. Timer callbacks
drain the runtime-owned `process.nextTick` queue synchronously. Browser native Promise jobs
remain deferred until the synchronous host drain returns. The portable scheduler bounds a single
drain at 100,000 callbacks to reject an endless interval or recursive timer.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Test fake-clock adapter](#test-fake-clock) | Host feature | Original TypeScript scheduler and Date adapter shared by all engines. |
