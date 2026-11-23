# Native goals Safari startup

Classification: original local adapter. No upstream source is copied or patched.

Server-stop observation failures retain their last completed observation, including
the shell's metadata-only runtime snapshot while stop remains pending. Cleanup
also tries to save the terminal after a failed stop before closing the transport.
This distinguishes a live process or listener from a pending shell acknowledgement;
it does not accept the stop until both shell and listener report stopped, change
the stop deadline, or turn failed cleanup into a pass.

`scripts/goals-matrix/native.ts` and `native-safari.ts` adapt the installed macOS
`launchctl`, `osascript`, `ps`, and SafariDriver commands for the goals campaign.
The existing Mac lock, owner availability check, and unlocked-console check run
first. Desktop Safari starts through LaunchServices. A helper, `launchctl asuser
<uid> /bin/sh -c 'trap "" TERM INT; exec osascript -l JavaScript'`, calls
`NSWorkspace launchApplicationAtURL` for `/Applications/Safari.app` and keeps the
returned `NSRunningApplication` for the rest of the run. There is no environment
or argument marker: LaunchServices ignores launch modifiers when it revives an
existing record.

The helper's single report is one of four outcomes:
- `launched`, with the PID and the request time;
- `not-launched`, when LaunchServices returned nothing;
- `existing`, when a live Safari already ran;
- `lost`, when its output ended without a report.

`lost` is never treated as a clean exit.

SafariDriver's HTTP service finds its Safari through LaunchServices, not through
the process table. On November 23, 2026 LaunchServices still held a record for a
Safari that a SafariDriver had launched on November 16 and that macOS later ended
through automatic termination. A directly executed Safari binary got a second,
separate record, so every session waited 30 seconds for the dead PID of the old
record. A LaunchServices launch revives that record with the new process, and the
session matched it in under a second. Launching the binary directly is therefore
not used.

The finite five-second GUI startup allowance, driver readiness bound and product
phase deadlines are unchanged. Simulator-only runs do not launch desktop Safari.
An already-running Safari is neither relaunched nor owned.

Immediately before calling LaunchServices, the helper checks
`NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.Safari")`.
It counts only instances whose process still answers `kill(pid, 0)`, so a stale
record for a dead Safari does not count. If one is live, it reports `existing`
without launching, and driver startup is refused. On the next line it records the
wall clock, rounded up to an integer microsecond, as the request time.

Ownership needs the reported PID's kernel birth, from
`proc_pidinfo(PROC_PIDTBSDINFO)` as integer microseconds, to be at or after that
request time. The comparison is done with `BigInt`, not in milliseconds or
`ps lstart` seconds. An owner Safari born earlier, even within the same
millisecond, is refused. `launchApplicationAtURL` returns an existing instance
unchanged, so a refused instance is never terminated; its helper is told to
`detach` and leaves it alone. The PID must keep that birth through the startup
allowance, and a second Safari after the allowance blocks driver startup.

One case cannot be told apart: an owner launch that reaches LaunchServices after
the helper's request but before it starts the process is merged into the same new
instance. That instance is still the one this request started, and it is
terminated with the run. The microsecond comparison was checked on the Mac (macOS
26.4, arm64): the request preceded Safari's kernel birth by 43 ms.

Once ownership is proved, the controller sends `own`. Cleanup never signals a PID.
It asks the helper to call `forceTerminate` on the retained `NSRunningApplication`,
which identifies the instance rather than a number that can be reused.
`forceTerminate` sends no Apple Event, so it needs no automation consent. Cleanup
also requires the original PID and birth to be gone; a reused PID with a new birth
does not count as the instance. Only then does it send `release`. Even after
`release`, the helper waits until AppKit reports the instance terminated and its
PID no longer answers `kill(pid, 0)`.

The helper runs in the workload's process group, and the LaunchServices Safari
does not. The installed Mac queue (`mac-queue-run.ts`, `monitor` and
`workRemains`) keeps its lock until that group has no live members, or until its
own workload timeout signals the group: SIGTERM first, then SIGKILL two seconds
later. The queue's ordinary cancellation also sends SIGTERM or SIGINT to the group.

The helper ignores SIGTERM and SIGINT. These ignored dispositions are inherited
through `launchctl` and `exec`; this was verified on the Mac. So on cancellation
the controller's own cleanup can still send `terminate`, provided it reaches that
step before the queue's SIGKILL. If the controller's input closes after `own` (the
controller crashed or was killed), the helper force-terminates the instance
itself, then waits for it to end. Closed input before `own` never touches Safari.

When termination is unproved, or the launch has not reported within ten seconds,
cleanup throws and the receipt records `safariExited: false`. It never sends
`release`, so the helper keeps holding the process group. A helper lost without a
report is likewise recorded as `safariExited: false`. The queue lock therefore
stays held until the instance ends, or until the queue's SIGKILL ends the group.
After that SIGKILL the lock is released even if Safari still runs. A helper that
reported `not-launched` or `existing` has already exited and owns nothing. No
preferences, automation settings, login state, or credentials change.

In the ordinary path the application stops only after driver exit is proved, and a
failed driver shutdown leaves the application running. With the opt-in Safari
exit capture (`safari-exit-observer.ts`), each teardown step is attempted on its
own: the application step still runs after a failed driver step, and the first
error is kept.

`fleet.ts` validates the collected native report before copying its artifacts.
Only a report with zero attempted cells may omit the terminal logs directory.
Attempted cells still require logs, and every collection requires its cleanup
receipt. Collection never upgrades an unproved driver or lock receipt.

Validated collection now saves the combined TABLE and its Markdown view before
either staging cleanup can fail. The normal and interrupted paths use this same
checkpoint, preserving local history, native attempts, logs and native cleanup
evidence while still propagating a later deletion error.

Fleet cleanup makes only directories inside its task-owned staging tree
owner-writable before deletion. It leaves file modes alone and does not follow
symbolic links into original or common inputs. Remote permission changes still
require the existing queue and native consumer settlement proof. Local cleanup
runs after the controller command has settled, including diagnostic and report
salvage scratch. Each directory gets its own `fleet-local-cleanup-*.json`, keyed
by its absolute path, recording local removal or its retained path and error.
Outer cleanup cannot overwrite failed salvage cleanup receipts;
`fleet-cleanup.json` retains the remote outcome.
An original operation or remote cleanup error aggregates with local cleanup
failure rather than being replaced. Tiny filesystem regressions exercise both
deletion paths and report survival, without a native session or framework build.

Lifetime and collection regressions retain their existing quality owners under
`checks/quality-goals-matrix-native.json` and `quality-goals-matrix-fleet.json`.
Actual native session creation and teardown are checked separately from injected
regressions; full framework acceptance remains a post-review campaign.

`run.ts` stops after failed cleanup for both native Safari selections, before
entering another cell. It saves the first phase error and separate cleanup error
before stopping, then reaps the asset server and saves the partial report again.
Unvisited cells retain their original status and empty attempt history. Independent
framework failures with successful cleanup still allow later cells to run.
The existing run quality owner checks this with two selected cells and local
transport controls, without starting a browser or contacting a Mac.

The native lifecycle imports `bounded.ts` directly rather than through the matrix
executor. It uses the same helper and timeouts, while standalone native adapters
avoid importing the executor's unused Playwright browser factory.

Commands with inherited output also forward captured stderr when its pipe closes,
including the fleet workload's allowed exit code 1. A failure before any report
now exposes its original diagnostic before collection or cleanup errors. The
same captured text still reaches `CommandExitError` for disallowed exit codes.
Signal handling, child reaping and native cleanup proof requirements are unchanged.
