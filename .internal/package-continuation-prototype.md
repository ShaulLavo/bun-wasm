# Package continuation prototype

Status: Approved bounded host-only prototype; guest enablement remains pending parent
disposition and independent implementation review.

The private target and binding are installed by the bounded handoff unit below. This is
not a completed feature: the package-script trigger remains disabled. The Safari memory
parent owns independent review and actual-engine integration.

## Required before any guest binding

1. Review the child admission correction. `supervisor.reserveSpawn` alone produces no
   Worker transport, so a real Bash Worker fails with `process has no admitted worker
   transport`. The prototype uses `WorkerProcessClient.spawn`, the broker's real admitted
   reservation/start path, a removable
   child listener and one consuming client wait followed by its receipt. Do not restore
   the host-only dummy-child path to claim real shell support.
2. Leave child controller ownership with the installed launcher. Released Waffle retains
   runtime-proc startup diagnostics for the typed parent wait without another controller.
   The removed extra controller conflicted with Bash's actual controller. Synchronous
   reservation failures use Waffle's bounded diagnostic encoding before rendering.
   Keep installed-launcher acceptance distinct from direct shell parsing controls.
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
6. Preserve Waffle .130's resolved foreign-launch contract: arbitrary throws without
   ownership proof correctly fail disposal. Do not wrap them in dummy handles or add a
   stop-only controller. Our owned continuation returns its handle immediately, selects
   startFailed before entry or fail afterward, and joins its caught work fence. A distinct
   cleanup rejection remains observable. No Waffle patch, API or pin is needed.
7. Test the actual guest transition on every maintained engine and the native unsupported
   route, ignored and pending signals across exec, caller-only versus job-wide signals,
   descendants, file/pipe stderr, denied cwd, each cancellation window and installer
   rollback/uninstall/reinstall. No memory-benefit, Safari or framework result is established.

Focused source tests run with `source env.sh && bun test tests/package/package-continuation.test.ts`.
The package's existing test glob owns them, so no extra check manifest is needed.
The report at `/work/reports/goals/safari-memory/package-continuation-prototype/RESULT.md`
contains actual shell controls, negative controls and cleanup.

## Bounded handoff unit

The executor captures the original root Descriptor after inherited binding application.
Successful DescriptorTable close/renumber operations update the tracked object; direct
reuse is also rejected by identity at census. This covers every WASI namespace linked
through the executor. The live census is inheritable descriptions plus the still-live
original root at current rights. No fixed-range fd scan or path reopen occurs.

Private `bun_package_scripts.handoff(plan_ptr, plan_len, scratch_ptr, scratch_capacity)`
returns a positive required scratch size without retaining references, or a negative
precommit errno. The second synchronous native call reparses primitive JSON, captures a
fresh census, serializes standard exec data into caller-owned memory and calls ordinary
exec before another guest callback or await. Successful commit never returns. Only
NOTSUP/NOSYS permit the future caller to retain its loop. Other private-target admission
errors are installation failures. Native cancellation wins before NOTSUP or pointers.

`continuationPlan` snapshots actual guest PATH/environment, planned npm_execpath, cwd,
silent/color/footer and existing pre/main/post rewrite/quoting results without mutating
lifecycle environment or emitting output. It is not invoked by `run`; the native method
is registered but unused there. No host shell parsing or rewriting is added.

Uninstall removes the private executable and ordinary Bun registrations. A single
resource-free private launcher remains in the Runtime adapter registry until Runtime
disposal because Waffle resolves that name after admission. It captures the Runtime's
filesystem service, never the installer's disposed filesystem client. Reinstall reuses
the launcher; failed first installation rolls it back. Actual controls cover uninstall
during held admission and a later reinstall.

The remaining integration boundary is wiring the prepared guest plan and errno handling
into `run` only after review, then actual maintained-engine transitions, full signal and
descendant acceptance, and end-to-end shell self-signal qualification. No memory saving
or Safari/framework result follows from the tiny runtime controls in this unit.
