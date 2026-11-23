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
<uid> osascript -l JavaScript`, calls `NSWorkspace launchApplicationAtURL` for
`/Applications/Safari.app`, prints the PID of the returned `NSRunningApplication`,
and keeps that object for the rest of the run. There is no environment or argument
marker: LaunchServices ignores launch modifiers when it revives an existing record.

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

Ownership needs the PID that LaunchServices reported to this request's helper and
a kernel birth for that PID at or after the request. The birth comes from
`proc_pidinfo(PROC_PIDTBSDINFO)` with microsecond precision, not one-second
`ps lstart`, so an owner Safari started earlier in the same second is refused.
`launchApplicationAtURL` returns an existing instance unchanged, so a refused
instance is never terminated; its helper is told to exit and leaves it alone.
The PID must keep that birth through the startup allowance, and a second Safari
after the allowance blocks driver startup. One case cannot be told apart: an owner
launch that reaches LaunchServices after this request but before it starts the
process is merged into the same new instance. That instance is still the one this
request started, and it is terminated with the run.

Cleanup never signals a PID. It asks the helper to call `forceTerminate` on the
retained `NSRunningApplication`, which identifies the instance rather than a
number that can be reused. `forceTerminate` sends no Apple Event, so it needs no
automation consent. The helper reports only that instance's termination. Cleanup
also requires the original PID and birth to be gone; a reused PID with a new birth
does not count as the instance.

The helper runs in the workload's process group. The installed Mac queue
(`mac-queue-run.ts`, `monitor` and `workRemains`) keeps its lock until that group
has no live members or the queue's own workload timeout stops the group. The
LaunchServices Safari itself is not in the group. On proved termination the helper
exits. On unproved termination, or when the launch request has not reported
within ten seconds, cleanup throws, the receipt records `safariExited: false`, and
the helper keeps waiting for its instance to end. The queue lock therefore stays
held until that Safari ends or the queue's workload timeout stops the group; after
that timeout the queue releases the lock even if Safari is still running. A helper
that reported no launch has already exited and owns nothing. No preferences,
automation settings, login state, or credentials change.

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
