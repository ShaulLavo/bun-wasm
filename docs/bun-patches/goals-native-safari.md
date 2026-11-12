# Native goals Safari startup

Classification: original local adapter. No upstream source is copied or patched.

`scripts/goals-matrix/native.ts` and `native-safari.ts` adapt the installed macOS
`launchctl`, `ps`, and SafariDriver commands for the goals campaign. The existing
Mac lock, owner availability check, and unlocked-console check run first.
Desktop Safari starts directly with `launchctl asuser <uid>
/Applications/Safari.app/Contents/MacOS/Safari`. The retained subprocess handle
must identify that exact live desktop Safari PID before the driver starts.
There is no LaunchServices `open` handoff or environment-marker assumption.

The finite five-second GUI startup allowance, driver readiness bound and product
phase deadlines are unchanged. Simulator-only runs do not launch desktop Safari.
An already-running Safari is neither relaunched nor owned. If an owner app races
startup, a different PID cannot become owned; a second application also blocks
driver startup. Process birth time checks only preserve an already-proved child
identity, never establish ownership.

Cleanup signals only the retained child after checking its PID and captured start
time. An uncaptured live child gets a finite opportunity to reach its executable;
unproved ownership retains the application and lock. A child that exits before
attribution also leaves cleanup unproved. The application stops only after driver exit is
proved. Failed driver shutdown preserves both its dependent application and lock.
No preferences, automation settings, login state, or credentials change.

`fleet.ts` validates the collected native report before copying its artifacts.
Only a report with zero attempted cells may omit the terminal logs directory.
Attempted cells still require logs, and every collection requires its cleanup
receipt. Collection never upgrades an unproved driver or lock receipt.

Lifetime and collection regressions retain their existing quality owners under
`checks/quality-goals-matrix-native.json` and `quality-goals-matrix-fleet.json`.
Actual native session creation and teardown are checked separately from injected
regressions; full framework acceptance remains a post-review campaign.

The native lifecycle imports `bounded.ts` directly rather than through the matrix
executor. It uses the same helper and timeouts, while standalone native adapters
avoid importing the executor's unused Playwright browser factory.

Commands with inherited output also forward captured stderr when its pipe closes,
including the fleet workload's allowed exit code 1. A failure before any report
now exposes its original diagnostic before collection or cleanup errors. The
same captured text still reaches `CommandExitError` for disallowed exit codes.
The lifetime quality check covers both inherited and captured command failures,
including their error type, exit code, diagnostic text and forwarding behavior.
Signal handling, child reaping and native cleanup proof requirements are unchanged.
