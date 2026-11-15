# Shared Browser member capture

Classification: Original test adapters. These extend bun-wasm's shared Browser
harness at `c4b8c429d735dcf3ce3a52fb872ab988ebd3fe8c`. No Bun, Node, WebKit or
other upstream implementation is copied. Production worker and executor APIs are
unchanged.

## Boundaries

`web/tests/shared-wasm-agent/capture.ts` wraps Waffle 0.0.131's public
`WorkerExecutor.namespaces`, `imports`, `initialize`, `run` and `beforeFinish`
hooks. It forwards the original arguments and results. Thrown values are recorded
and rethrown unchanged. Diagnostic read failures increment an explicit counter.
They cannot replace an execution error. No diagnostic calls a guest export.

The import hook observes the standard preview1 `fd_write` boundary. It retains
attempted stderr separately from bytes the original write reports as accepted.
It never reads a pipe. The namespaces hook observes the existing host `post`
callback, including nested-core fatal diagnostics written directly to child stderr.
The `runtime_nested.request` wrapper retains the current operation and its host
entry stack before entering nested execution, plus any error that escapes it.

`capture-page.ts` binds that record to the actual Worker launch argv, its named
agent and Waffle's admitted process observation. The public
`captureProcessObserver` validates the incarnation and reads selected or terminated
outcomes without worker execution. Worker terminal messages retain their cleanup
errors. A native terminate return is labeled as such, independently of the process
observation and the existing Web Lock agent-close proof.

`worker.ts` uses the same Waffle bootstrap and `createBunExecutor` as the production
entry. It preserves the production entry's concurrent terminal/nested imports,
early process observation and captured host methods. Ordinary non-group requests
receive no capture wrapper. The existing SpiderMonkey stack witness and agent
lock remain installed.

Each group worker has one 64 KiB host-owned shared record. A sequence word makes
concurrent reads either complete or explicitly `writing`; readers do not retry.
The record contains two 2,048-character stderr tails, the last four active host
frames, four escaping-error records and the current lifecycle phase. Stacks are
bounded to 900 characters at entry and 1,000 characters on failure. The page keeps
at most 64 completed member records, retiring older native-terminated workers
when admitting another capture. Live members are retained.

## Failure reporting

`shared-wasm-memory-browser-main.ts` adds the records to its existing progress and
result facts. The driver retains its existing 20-second progress checkpoints. On
the existing wait/error boundary it prints the original error stack and the last
checkpoint, attempts one fresh page read, then rethrows the original error. An
unavailable page read is reported explicitly with the retained checkpoint.
Assertions, integrity checks, profile selection and hang caps are unchanged.

The entry stack is the last observed host boundary, not a sampled live guest
stack. This cannot locate a JSC instruction while its worker is blocked outside
an observed import. EngineHost's `onWasmCallTrap` serves the Browser engine and is
not an embedded JSC boundary. A synchronous Wasi launch can also end before
`WorkerExecutor.run`; its nested imports are still observed. These records do not
by themselves establish stack exhaustion or the cause of a hang.

## Executable controls

The shared-group check in `checks/browser-guest-shared-wasm-member-capture.json`
uses the selected real engine, production bootstrap and Waffle process service.
Its SpiderMonkey control explicitly selects the interpreter. The original
shared-memory qualification retains both SpiderMonkey tiers.

The child writes stderr and blocks indefinitely in a real nested Wasm futex call.
The page must observe its argv, admitted PID, pending outcome, accepted stderr and
active host stack before releasing the parent. The parent then kills the child
and receives the same stderr through the original pipe. Another child exits 7.
In that worker, controls preserve a caught RangeError's identity, catch a real
host Wasm `unreachable`, dispatch a synthetic standard ErrorEvent, and inject a
cleanup error after the real cleanup returned. The capture and terminal message
must retain their stacks and the final page budget must be zero.

A second control closes the page after capturing the blocked child. It requires
the driver's real page-closed error, retained checkpoint and explicit failed-read
record. The normal teardown closes the browser and removes its scratch.

The Web-owned host checks cover partial writes, errno, exact thrown-value identity,
cleanup failure, Unicode bounds, observation-error accounting and a concurrent
`writing` record. Feature manifests retain the existing blocking owners.
