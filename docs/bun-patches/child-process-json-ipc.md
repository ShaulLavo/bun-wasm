## Child process JSON IPC

Class **Host feature**, original adapter. No upstream source is copied or adapted.
`crates/bunwasm-runtime/src/js/child_ipc.ts`, `spawn.ts` and `bootstrap.js`
implement the documented Node child-process JSON messaging contract over the
existing Waffle descriptor ABI, as pinned at `f6017d12f59c81dae75eece5a6cb62c0470d166e` when written.
Two explicit pipe bindings carry newline-delimited UTF-8 JSON in each direction.
The child learns its read/write descriptors from a consumed environment entry.
There is no new host broker, Bun-specific transport or implicit descriptor inheritance.

`fork()` adds its default IPC channel. Node `spawn()` accepts one `ipc` stdio
entry after stdin/stdout/stderr, and Bun `spawn()` accepts an `ipc` callback.
Both sides expose send/disconnect and connected state; Node endpoints emit
message/disconnect events. Writes retain partial offsets and ordered asynchronous
callbacks. Disconnect rejects new sends, drains accepted writes and releases both
ends. Live input reads stop after 32 records per event-loop turn. Once child exit
is published, completion drains its finite buffered input through EOF without that
fairness limit, then closes endpoints once. Terminal events follow those frames.
Child message/disconnect listeners and queued writes hold the event loop alive;
without those listeners the channel alone does not hold the child open.

Only JSON serialization is supported. Advanced serialization, handle transfer,
synchronous IPC and placing IPC in stdin/stdout/stderr are explicitly unsupported.
This is the channel required for Next's ready/options exchange, not proof that
Next dev/build/start or its compiler and networking paths work.

Focused unit tests are `scripts/child-process-ipc.test.ts`. For literal-browser
acceptance, build the modified Browser guest and web assets, then run
`bun web/tests/browser-child-process-ipc.ts` through the host's browser queue.
The gate forks two children simultaneously, exchanges dynamic queued JSON and
callbacks, checks disconnect/error and ordinary-exit cleanup, drains 257 separately
written messages from an exited child while its parent was occupied, and reads the
result through the real Waffle service-worker HTTP preview. It never executes
guest source on the host JavaScript engine.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Child process JSON IPC](#child-process-json-ipc) | Host feature | Original TypeScript JSON framing and lifecycle adapter over Waffle runtime_proc pipes, including implicit fork channels and process bootstrap. |
