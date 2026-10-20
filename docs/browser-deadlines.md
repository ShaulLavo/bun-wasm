# Browser command deadlines

`scripts/run-with-timeout.mts` runs a command with a deadline and waits for its
owned descendants to stop. It preserves ordinary exit codes, reports 124 for a
deadline, and reports 130 or 143 for SIGINT or SIGTERM. Descendants get five
seconds for graceful shutdown, followed by a two-second force-stop bound.

On Linux, the supervisor becomes a child subreaper before launching the command.
The kernel reparents orphaned descendants to this supervisor, including detached
browser sessions whose launcher dies between process snapshots. Discovery starts
from direct children and previously recorded PID-and-birth identities. Every
signal rechecks the current birth identity. Neither environment markers nor
process-group membership authorize a kill.

The Linux helper requires Bun and glibc. Bun FFI calls `prctl` without building a
native addon. A Node entry briefly execs through Bun to enable subreaping, then
execs back into the original Node runtime at the same PID. The helper adds no
persistent process. Non-Linux discovery retains its existing process snapshots.

Run the focused contract with:

```sh
source env.sh
bun test scripts/run-with-timeout-browser.test.ts scripts/run-with-timeout.test.ts
```

The five real-Chromium cases also run in the blocking Web host browser gate.
The abrupt-launcher fixture pauses the supervisor, starts stopped real Chromium
without the deadline marker, kills its launcher, then resumes the supervisor
only after the launcher is gone. This forces the missed-ancestry condition
without timing retries. Each scenario preserves a separate browser and owner
until its independent PID-and-birth teardown, then verifies owned survivors are
absent and removes its scratch directory.
