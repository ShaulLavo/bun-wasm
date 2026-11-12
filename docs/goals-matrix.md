# Run the framework matrix

Stage the retained delivery before building current playground JavaScript:

```sh
source env.sh
TMPDIR=/work/tmp bun /work/heavy-runner/current/run.js --class build goals-matrix-prepare -- \
  bun scripts/goals-matrix/prepare.ts /absolute/delivery
```

The preparation command checks the shell receipt and bytes against the current consumer,
expands the engine pairs in task-owned scratch, and builds with those inputs. It
then checks embedded host fingerprints, engine-builds.json, and actual staged
bytes. Copying WASM into an already built host is rejected before any cells run.
Keep the WASM delivery source separate from the playground source commit.
Preparation records the built host source in `goals-host-source.json`. Continuation
compares every staged host, worker, template and guest file, not just WASM bytes.

To add an ordinary SpiderMonkey interpreter pair from a separate producer, pass
its directory and existing JSON source record when preparing the same delivery:

```sh
source env.sh
TMPDIR=/work/tmp bun /work/heavy-runner/current/run.js --class build goals-sm-prepare -- \
	bun scripts/goals-matrix/prepare.ts /absolute/delivery \
	--spidermonkey=/absolute/ordinary-pair \
	--spidermonkey-source=/absolute/component-sources.json \
	--shell=/absolute/current-shell-guests
```

The directory must contain `bun-spidermonkey.wasm` and
`spidermonkey-engine.wasm`, each plain or gzip compressed with a `.gz` suffix.
Both files come from this directory. Missing files fail before the build, even
when the delivery contains another SpiderMonkey pair. Other engine inputs stay
in the delivery. No guest rebuild is needed. Use ordinary interpreter artifacts,
not shared-profile cores or sides.

Preparation records the unchanged delivery manifest, the separate source record,
and the selected pair's byte hashes in `web/dist/goals-asset-sources.json`. Keep
each component's actual source in that record when core and side differ. The
host fingerprint checks still apply. When the delivery has an older shell pin,
select current shell guests with `--shell`. That directory must contain the
maintained shell builder's `bash-web-guests.json`, `bash-web-shell.wasm`, and
`bash-web-env.wasm`. Preparation verifies the receipt against the current
consumer's shell pin and file hashes, stages those guests, and records the receipt.
Without `--shell`, preparation uses `BASH_WEB_GUESTS_DIR` or the checkout's `dist` directory. Its receipt and bytes must still match the current host pin. The verified builder stages them; preparation never overwrites them with donor programs after the build. `goals-site-inventory.json` records every prepared file and is checked before campaigns start.
For a bounded
Chrome campaign, run Hono first, then append Vite React with the same clean source:

```sh
bun /work/heavy-runner/current/run.js --class browser goals-sm-hono -- \
	bun scripts/goals-matrix/run.ts --browsers=chrome --engines=spidermonkey \
	--frameworks=hono --asset-source="$PWD/web/dist/goals-asset-sources.json" \
	--output=/absolute/campaign
bun /work/heavy-runner/current/run.js --class browser goals-sm-vite -- \
	bun scripts/goals-matrix/run.ts --browsers=chrome --engines=spidermonkey \
	--frameworks=vite-react --asset-source="$PWD/web/dist/goals-asset-sources.json" \
	--output=/absolute/campaign --resume
```

Discovery only establishes prerequisites. Inspect `TABLE.json` for actual phase
results and cleanup. Unselected boxes remain pending.

Run all 208 boxes. Hermes is parked and excluded from this matrix:

```sh
source env.sh
bun /work/heavy-runner/current/run.js --class browser goals-matrix -- \
  bun scripts/goals-matrix/fleet.ts --asset-source=/absolute/delivery-manifest.json \
  --device-udid=CLAIMED_SIMULATOR_UDID \
  --mac-lane=YOUR-LANE --mac-thread=YOUR-T3-THREAD-ID
```

Use T3 `device_list` and `device_open` to claim an unclaimed iPhone simulator first.
Use its returned pinned command for native Safari app actions. The fleet runner
stages a generated runner and the static build to a unique Mac task directory,
checks the owner reservation, and runs the whole native workload through the
installed Mac FIFO queue. Supply your lane and actual T3 thread ID, copied
unchanged including any opaque prefix. The queue owns admission and lock release.
The workload owns its SafariDriver and server.
The default queue estimate is 600 seconds, wait budget is 3600 seconds, and workload
limit is 900 seconds. Set `--mac-expected-seconds`, `--mac-wait-seconds`, and
`--mac-timeout-seconds` for a different bounded campaign. These limits do not change
framework phase deadlines. The dependency install runs inside admission too.
Direct automatic native `run.ts` invocations use the same installed CLI. Native
resource helpers reject callers outside its supervised process group.
Queue release does not prove that external native consumers stopped. After the
workload starts, staging removal also requires successful native driver and Safari
teardown. Missing or failed cleanup evidence retains staging for recovery.
Cancellation before workload admission is checked separately.
It never boots, erases, or shuts down a simulator. Close the task device session
afterward and restore only its task-owned boot state through T3.

The runner writes `/work/reports/goals/TABLE.md`, `TABLE.json`, and terminal logs.
It saves after each box. Pass requires development render, a counter click, an
editor save that updates the existing preview, production build and preview, and
successful cleanup. It does not reload the page to make the edit appear.

Use `--browsers=chrome,firefox`, `--engines=browser`, or
`--frameworks=vite-react,next` for bounded selections. Unselected boxes remain
pending, never pass. Omit timeout flags for the fixed per-cell campaign policy.
An explicit `--timeout-ms=180000` overrides phase, install and build limits,
retaining the Next build minimum and fixed cleanup bounds. `--resume` continues
an unchanged clean source and asset identity. Failed attempts remain in the JSON;
add `--retry-failures` to append a new attempt rather than erase the old one.
Use a different `--output=/absolute/path` for independent shards or controls.
Never run concurrent writers against the same report directory.

Chrome uses the installed Chrome channel, not a renamed Chromium result. Firefox
uses Playwright Firefox. For local shards, run `bun scripts/goals-matrix/run.ts` with the same options.
Native desktop Safari and native iPhone simulator Safari
use real WebDriver endpoints configured with `--safari-endpoint=http://…` and
`--iphone-endpoint=http://…`. `--device-udid=…` selects the claimed simulator.
Playwright WebKit and mobile emulation are not accepted browser names. Reserve the
Mac and simulator through the fleet workflow before starting the endpoints.
Missing engines, assets, templates, or native endpoints remain not runnable yet
with their discovery evidence. A browser or guest that starts and fails is a
failed attempt with its first concrete phase error.

Set `GOALS_CHROME_EXECUTABLE` when Google Chrome is installed outside its normal
location. The runner checks the executable reports Google Chrome. Chromium is not
accepted under the Chrome label. Generated Mac runner dependencies install only
inside the task directory; shared browser and download caches remain available.

Native SafariDriver starts through `launchctl asuser` in the Mac GUI login session.
An SSH-launched driver without that GUI context can time out waiting for
RWIApplication even when remote automation is already enabled.

### Run visible iPhone Safari with XCTest input

Use this path when native taps are required. It creates no iPhone SafariDriver
session. Finish desktop Safari first, then close its driver before taking the Mac
lock for this run. Claim the simulator with T3 `device_open` and keep the exact
bound `agent-device` command it returns on the PC.

Build `scripts/goals-matrix/iphone-server.ts` and `iphone-mac.ts` with
`bun build --target=bun`. Stage both bundles and the unchanged prepared playground
in a unique Mac task directory. Start the wrapper there with `HOST=127.0.0.1`,
`PORT=0`, `PREVIEW_ORIGINS=1`, `ROOT` set to the staged playground,
and `GOALS_IPHONE_TOKEN` set to a random 64-character hexadecimal test token:

```sh
~/.bun/bin/bun ~/.agents/skills/machine-fleet/scripts/mac-queue.ts run \
  --lane YOUR-LANE --thread YOUR-T3-THREAD-ID --task "Visible iPhone campaign" \
  --expected-seconds 600 --wait-seconds 3600 --timeout-seconds 900 -- \
  ~/.bun/bin/bun /absolute/iphone-mac.js /absolute/iphone-server.js /absolute/cleanup.json
```

The wrapper requires installed queue admission, checks the owner reservation,
refuses any running SafariDriver, and stops its owned server. Only the queue
supervisor releases the lock after all supervised consumers stop. The server prints
its loopback control URL. Forward that port to the PC with an owned SSH port
forward. Pass the forwarded URL, with the unchanged token path, to the runner:

```sh
source env.sh
bun scripts/goals-matrix/run.ts --browsers=iphone-safari \
  --root=/absolute/prepared-site --asset-source=/absolute/asset-sources.json \
  --output=/absolute/new-iphone-campaign \
  --device-udid=CLAIMED_SIMULATOR_UDID \
  --iphone-control-url=http://127.0.0.1:FORWARDED_PORT/__goals_iphone/TOKEN \
  --iphone-agent-command=/exact/path/returned/by/device_open/agent-device
```

Run the PC controller through its heavy browser runner. The native transport opens
the real Safari page, presents the actual framework preview, and records each
bound command in `logs/*.native.jsonl`. A unique accessibility button reference,
trusted DOM event, unchanged document, and counter increment must agree. A device
command failure stops the campaign and leaves its exact error in the report.
All existing phase deadlines apply, including the 20-second cleanup limit.

Stop the wrapper and owned port forward after the campaign, copy its cleanup
receipt, and verify the recorded server PID and listeners are absent. Check the
installed queue status for the completed task before removing staging. A native
cleanup receipt never claims queue release, and another task may already hold the lock. Close only the task's T3 device session without
shutting down the retained simulator. Preserve original reports and asset inputs.

Fleet browser selections are respected on both hosts. A Chrome-only run does not
require a simulator or visit the Mac. Unavailable Mac prerequisites are saved as
not runnable yet, without inventing per-box attempts. Interruption owns setup
subprocesses as well as browser cleanup. If remote shutdown cannot be proved,
the runner retains its unique staging directory and records its removal condition
in `fleet-cleanup.json` instead of deleting files under a live process.

## Choose an install deadline

The default policy is fixed per framework, browser and engine. Reports record
its provenance and effective limits. Campaigns never learn new budgets while
running. An explicit
`--timeout-ms=90000` still gives every framework install 90,000 ms unless you
also set an install override. Cleanup keeps its existing 20,000 ms outer bound
and shorter inner bounds. No install override changes startup, dev, render,
click, hot reload, build, preview, browser navigation, or cleanup deadlines.

To choose 110,000 ms for Nuxt's cold install while keeping the other selected
framework installs and campaign phases at 90,000 ms, use a new report directory:

```sh
source env.sh
bun /work/heavy-runner/current/run.js --class browser goals-install-policy -- \
	bun scripts/goals-matrix/fleet.ts --root=/absolute/prepared-site \
	--asset-source=/absolute/delivery-manifest.json \
	--output=/absolute/new-campaign --browsers=chrome,safari --engines=browser \
	--frameworks=nuxt,astro,react-router,solidstart,tanstack-start,angular \
	--timeout-ms=90000 --install-timeout-ms=nuxt:110000 \
	--mac-lane=YOUR-LANE --mac-thread=YOUR-T3-THREAD-ID
```

The same options work with `run.ts` and explicit native WebDriver endpoints.
The fleet controller forwards the override unchanged to its native controller.
`--install-timeout-ms` accepts comma-separated `framework:milliseconds` pairs.
Each framework must be in the goals catalog. Each duration must be a decimal
integer from 100 through 900,000. Unknown frameworks, duplicate pairs, empty
entries, and repeated flags are errors. An override applies to that framework's
install phase across selected browsers and engines. It does not change cache
behavior or other frameworks, and no Nuxt override is enabled implicitly.

For a read-only summary of independent historical runs, use the
[framework evidence view](goals-report-view.md). It never creates a resumable campaign.

Reports use schema 2. `TABLE.json` records effective phase, install and build
deadlines for every cell, calibration provenance, explicit CLI overrides and the fixed cleanup deadline in
`deadlines`. Each phase records its own `timeoutMs`, checked against that policy
when the report is read. `TABLE.md` shows the command and effective deadlines.
Continuation and shard combination reject different effective policies, even
when source and asset identities match. Explicit overrides are part of the
recorded policy, including an override equal to a default.
Source and artifact identity checks still apply. Schema 1 reports stay historical
files, not continuation inputs. Start a new output directory rather than copying
old rows into a campaign with a changed policy. Failed attempts within an
unchanged campaign remain in the JSON when retried.

### Why the Nuxt campaign chooses 110 seconds

The November 8, 2026 diagnostics completed Nuxt's install in 85.433 seconds on
Google Chrome 157 and 97.990 seconds on native desktop Safari 26.4. These were
fresh sessions with empty, enabled Cache Storage, memory-only guest storage,
and the same final source and frozen assets. Both installed 657 packages and
requested the same 1,183 npm URLs. Completion followed the last network response
by only 0.185 and 0.726 seconds. No material separate final hotspot was demonstrated.

The coordinator's explicit 110,000 ms choice gives about 12.3 percent above the
slowest observed completion. There was one completion per actual browser, not a
percentile estimate or a guarantee against future registry or host variation.
The original 90-second misses remain failures. The completed diagnostic runs
are not acceptance results. Ordinary merged-source acceptance still runs
separately under the selected policy.

The exact measurement evidence is `/work/reports/goals/installs/nuxt-tail/RESULT.md`,
`/work/reports/goals/installs/nuxt-tail/stage-summary.json`,
`/work/reports/goals/installs/nuxt-tail/chrome.json`, and
`/work/reports/goals/installs/nuxt-tail/collected/safari.json`.
Those runs used source `c55a206ed38e8cc0737bfea5f8eec1a357015cf6` and guest SHA-256
`05952225469a7647ff726149236561cc9f54a90f6f96f0a65b2b86002eb853db`.

## Measured Next build bound

Cells without a complete pass retain the original 90 second defaults and
110 second Next build bound. Measured cells use the fixed reviewed calibration;
Next on SpiderMonkey retains its lane's existing limits and explicit overrides.
Cleanup retains its separate 20 second limit and shorter inner bounds.
Reports include effective phase, install and build bounds for every cell. Historical
90 second failures are not rewritten or resumed with a different policy.

The Pages starter excludes only the pinned unused Turbopack and experimental
React production runtime files from Next server tracing. A restricted-dependency
SSR control validates the selected trace, including a missing-runtime negative
control. See [the adapter record](bun-patches/next-build-scheduling.md).

## Measure the root React sandbox

For a PC campaign, pass `--react-startup-url=http://127.0.0.1:PORT/` to
`run.ts` or `fleet.ts`. Serve the matching production sandbox build on that
explicit free port first. This check runs once on the local controller before
the matrix and writes `react-startup.json` beside `TABLE.json`.

The check uses three fresh Chromium contexts. Each cold navigation starts without
HTTP, service worker, guest filesystem, or package state. Each warm measurement
reloads the same context after the cold preview renders and its counter works.
The browser process and OS cache remain shared. The renderer must display the
React heading and counter, paint two frames, and increment the counter. Listening
or an iframe load alone does not pass. Observed HTTP errors fail the check.

The cold median render budget is 6,900 ms. Warm samples cannot replace cold
samples. Each complete sample has a fixed 30,000 ms failure deadline, independent
of campaign or install overrides. The budget is about 14.9 percent above the
6,004.2 ms local good cold median measured on November 8, 2026. Recalibrate on a
named execution host before treating that number as portable to other machines.
This flag does not enable itself in existing scheduled campaigns.

To compare two builds without enforcing that machine-specific budget, run:

```sh
source env.sh
bun scripts/measure-react-startup.ts --url http://127.0.0.1:48941/ \
  --baseline http://127.0.0.1:48942/ --samples 3 --headed \
  --revision current --baseline-revision previous --output /absolute/startup.json
```

Use the same host and browser for both URLs. The runner alternates revision order
and records installed React and Vite versions, startup phases, cache-hit marks,
response statuses, browser version, and browser cleanup. `--limit-ms` enforces a
cold median limit for the current revision, never the average of both revisions.
Warm renders also must stay below that limit.

For native WebDriver ownership evidence, add `--safari-ownership` to `run.ts` or
`fleet.ts`. Each cell attempt appends synchronous JSONL observations under
`logs/<cell>.ownership-<capture-uuid>.jsonl`. Every row includes the controller
source commit and dirty flag, run, cell, attempt, capture UUID, timestamp, event
number, sequence, session ID and observed host handle. Retry and resumed captures
use new filenames. Fleet collects these logs with ordinary reports. After an
interruption it waits for the writer to settle, then copies final logs before
removing staging. Failed final collection retains staging. Proved cancellation
before the workload starts needs no logs.

Only this run's existing requests supply identifiers. Frame presentation tokens
are local intent until the presentation request is acknowledged. Element references
come from the existing identity-checked lookup. A frame removal acknowledgement
is not a native window close. A tab-close or session-delete acknowledgement is a
WebDriver response, not independent proof of OS-window absence. Missing responses,
invalid sessions and lost connections leave effects unknown. Opaque handles are
not OS window IDs or WebContent PIDs. No such PID witness is available here.
The receipt excludes URLs, page contents, scripts, cookies and request bodies.
Capture is off by default. A synchronous sink failure does not interrupt mandatory
cleanup; it makes session cleanup fail after deletion has been attempted.
