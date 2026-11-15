# Check a prepared deployment on iPhone Safari

Run this manual check before declaring a sandbox deployment complete. It checks
Vite React with Browser, Hono with Browser, and Vite React with QuickJS, in that
order. Each case must start, install dependencies, start its dev server, render
the expected heading, and increment its counter through a trusted native tap.
This smoke does not check hot reload, production build, or production preview.
Its result is separate from the [full goals matrix](../goals-matrix.md).

## Prepare the inputs

Build the playground locally on the PC through the heavy runner from the commit
you want to check. A local prepared root is valid. You do not need CI artifacts,
delivery receipts, or a goals-site inventory. The root must contain `index.html`,
`engine-builds.json`, and Browser and QuickJS engine files. The runner checks the
embedded host fingerprints against the guest bytes to catch mixed builds.
The [goals-matrix guide](../goals-matrix.md) describes engine staging and preparation.
Run the smoke command from the selected revision's checkout so preflight reads
the same runtime sources used for its local build. Queue commands such as claim
and complete use the installed watcher's checkout.

Record the build's 40-character commit in `--source-file`, for example
`{"commit":"YOUR_FULL_COMMIT"}`. Optional `dirty` and `assets` fields retain
additional build details. The runner records the commit and artifact source in
every case. It does not rebuild or deploy a site.

1. Call T3 `device_list`. Select iPhone 17e with UDID
   `C4D2FFD4-A0D2-4608-B180-35854521B830` on the Mac device host.
2. Use the maintained [visible iPhone wrapper and Mac FIFO](../goals-matrix.md#run-visible-iphone-safari-with-xctest-input)
   to serve the same prepared bytes on the Mac and forward its observer port.
   Set `--mac-thread` below to the FIFO holder's thread ID. Keep that wrapper and
   admission alive for the entire smoke. A 6,000-second workload hang cap covers
   all three cases and their cleanup. Queue wait time is separate.
3. Once the FIFO admits your wrapper and its server is ready, call `device_open`
   with that device's host ID and UDID. Keep its exact absolute bound
   `agent-device` command. The runner uses it for Safari, taps, and tab cleanup.

The runner verifies the same supervised FIFO ticket before each case. It does
not acquire another Mac ticket. The wrapper checks owner availability and refuses
an active SafariDriver. Do not run this check alongside a native Safari campaign.

## Run the smoke

Use a fresh output directory whose parent already exists. All value options use
`--name=value`. List the supported cases with `bun scripts/iphone-smoke.ts --list`.

```sh
source env.sh
bun /work/heavy-runner/current/run.js --host local --class browser iphone-smoke -- \
	bun scripts/iphone-smoke.ts \
	--root=/absolute/prepared-site \
	--output=/absolute/results/new-iphone-smoke \
	--source-file=/absolute/source.json \
	--iphone-control-url=http://127.0.0.1:FORWARDED_PORT/__goals_iphone/TOKEN \
	--iphone-agent-command=/exact/device_open/path/agent-device \
	--device-udid=C4D2FFD4-A0D2-4608-B180-35854521B830 \
	--mac-thread=FIFO_HOLDER_THREAD
```

`--asset-source` defaults to the prepared root path. Use it to label another build
source when the source file omits `assets`. The remaining options above are
required. Other devices, engines, and case selections are rejected.

Startup, dev, render, and click each have a five-minute hang cap. Install has a
ten-minute hang cap. The maintained cleanup phase has a twenty-second hang cap.
Every phase records its actual duration. A slow successful outcome passes.

## Read the result and finish cleanup

Read `<output>/result.json`. `status` is `green` only when all three cases pass,
their cleanup succeeds, and the host and guest fingerprints still match. `failedPhase`
names the first failure. Each case retains its phases, actual durations, failures,
source identity, browser identity, and cleanup evidence. Logs and native command
evidence are under `<output>/logs`. The command exits nonzero for any failure,
blocked case, or interruption. It never writes a canonical matrix table.

An ordinary framework failure skips its later phases and attempts the remaining
cases. A failed device command, failed cleanup, changed FIFO ticket, or
interruption blocks further native input. Prerequisite failures produce a red
result before any device command. The runner atomically saves the result after
each case and at completion.

The runner closes only its owned Safari tabs and guest processes. After it exits,
stop the wrapper and owned forward, collect the wrapper's cleanup receipt, verify
that its server and listeners stopped, and check that its FIFO ticket is gone.
Remove task staging only after its consumers stop. Close your T3 device session
without shutting down the retained simulator. Keep the results. Remove disposable
builds after use. The smoke's green result covers case cleanup. The deployment
operator also owns wrapper, forward, session, and staging cleanup.
