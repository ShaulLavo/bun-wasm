# Package continuation prototype

Status: Approved bounded host-only prototype; guest enablement remains pending parent
disposition and independent implementation review.

The private module is imported by package tests only. Do not add it to the package
entrypoints or installer as a completed feature. The Safari memory parent owns follow-up.

## Required before any guest binding

1. Review the child admission correction. `supervisor.reserveSpawn` alone produces no
   Worker transport, so a real Bash Worker fails with `process has no admitted worker
   transport`. The prototype uses `WorkerProcessClient.spawn`, controller registration
   before message delivery, the broker's real admitted reservation/start path, a removable
   child listener and one consuming client wait followed by its receipt. Do not restore
   the host-only dummy-child path to claim real shell support.
2. Compose startup capture with the installed Bash launcher's own controller. Released
   `bash-web` `src/runtime/worker-launcher.ts:116` registers a controller unconditionally;
   our earlier registration makes it throw `Process N already has a controller`.
   The direct shell Worker control tests parsing but does not qualify this installer.
   Do not enable the guest trigger until parent chooses and reviews the integration.
3. Keep one successor filesystem connection and client. A second `connect(identity)`
   consumes no already-adopted reservations and its service session rejects those
   handles with EBADF. A second client on one connection also replaces the port handler.
   The private stderr adaptation shares its single client with cwd and child transfer.
4. Implement the reviewed live-WASI census at the executor, after inherited bindings.
   Track the original root Descriptor by object identity through successful close and
   renumber; transfer its current rights only while still live. Carry `inheritable()` plus
   that original binding synchronously into standard exec. Never use inherited_fd, scan
   a fixed maximum, revive a dup as the preopen or reopen `/`. The current host tests grant
   initial fixture authority; they are not a guest census qualification.
5. Snapshot the existing guest table, prepared pre/main/post commands, actual environment
   after PATH/npm_execpath updates, cwd, silent/color and platform footer. Add the private
   native import on both hosts only after review. Native checks cancellation before
   pointers and returns NOTSUP. Root/group/thread callers, caught signal dispositions,
   unsupported filesystem modes or unqualified shell launchers must return precommit
   NOTSUP/NOSYS to the untouched loop exactly once, before announcements or phase mutation.
   Missing private registration is an installation failure, not fallback. Do not claim
   caught-handler fidelity from exec resetting those handlers.
6. Resolve the isolated foreign-adapter-throw cleanup failure with the parent/Waffle
   owner. The continuation itself catches its body error once and joins a non-rethrowing
   fence; it cannot clear the runtime's retained rejecting foreign launch promise.
   A distinct local cleanup rejection must remain observable.
7. Test the actual guest transition on every maintained engine and the native unsupported
   route, ignored and pending signals across exec, caller-only versus job-wide signals,
   descendants, file/pipe stderr, denied cwd, each cancellation window and installer
   rollback/uninstall/reinstall. No memory-benefit, Safari or framework result is established.

Focused source tests run with `source env.sh && bun test tests/package/package-continuation.test.ts`.
The package's existing test glob owns them, so no extra check manifest is needed.
The report at `/work/reports/goals/safari-memory/package-continuation-prototype/RESULT.md`
contains actual shell controls, negative controls and cleanup.
