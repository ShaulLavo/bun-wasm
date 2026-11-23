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
first. Desktop Safari starts through LaunchServices: `launchctl asuser <uid>
osascript -l JavaScript` calls `NSWorkspace launchApplicationAtURL` for
`/Applications/Safari.app` and prints the PID of the returned
`NSRunningApplication`. There is no environment or argument marker: LaunchServices
ignores launch modifiers when it revives an existing record.

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
An already-running Safari is neither relaunched nor owned. Ownership needs both
the PID LaunchServices reported for this request and a live desktop Safari row
for that PID that started no earlier than the request's second (`ps lstart`
precision). An instance LaunchServices returns that started before the request
is never owned. A second Safari after the startup allowance blocks driver startup.

Cleanup signals only the owned PID after re-checking its captured start time, and
waits a finite time for it to exit before escalating once. A launch request whose
PID was never attributed gets a finite settle period; any Safari started since the
request then leaves cleanup unproved, preserving the application and lock. The
application stops only after driver exit is proved. Failed driver shutdown
preserves both its dependent application and lock. No preferences, automation
settings, login state, or credentials change.

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
