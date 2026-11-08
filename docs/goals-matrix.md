# Run the framework matrix

Stage the retained delivery before building current playground JavaScript:

```sh
source env.sh
TMPDIR=/work/tmp bun /work/heavy-runner/current/run.js --class build goals-matrix-prepare -- \
  bun scripts/goals-matrix/prepare.ts /absolute/delivery
```

The preparation command checks the delivery shell pin against the current consumer,
expands the engine pairs in task-owned scratch, and builds with those inputs. It
then checks embedded host fingerprints, engine-builds.json, and actual staged
bytes. Copying WASM into an already built host is rejected before any cells run.
Keep the WASM delivery source separate from the playground source commit.
Preparation records the built host source in `goals-host-source.json`. Continuation
compares every staged host, worker, template and guest file, not just WASM bytes.

Run all 260 boxes:

```sh
source env.sh
bun /work/heavy-runner/current/run.js --class browser goals-matrix -- \
  bun scripts/goals-matrix/fleet.ts --asset-source=/absolute/delivery-manifest.json \
  --device-udid=CLAIMED_SIMULATOR_UDID
```

Use T3 `device_list` and `device_open` to claim an unclaimed iPhone simulator first.
Use its returned pinned command for native Safari app actions. The fleet runner
stages a generated runner and the static build to a unique Mac task directory,
checks the owner reservation, takes the Mac lock, and owns its SafariDriver.
It never boots, erases, or shuts down a simulator. Close the task device session
afterward and restore only its task-owned boot state through T3.

The runner writes `/work/reports/goals/TABLE.md`, `TABLE.json`, and terminal logs.
It saves after each box. Pass requires development render, a counter click, an
editor save that updates the existing preview, production build and preview, and
successful cleanup. It does not reload the page to make the edit appear.

Use `--browsers=chrome,firefox`, `--engines=browser`, or
`--frameworks=vite-react,next` for bounded selections. Unselected boxes remain
pending, never pass. `--timeout-ms=180000` bounds campaign phases, except cleanup
with its shorter fixed bounds. `--resume` continues
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

Fleet browser selections are respected on both hosts. A Chrome-only run does not
require a simulator or visit the Mac. Unavailable Mac prerequisites are saved as
not runnable yet, without inventing per-box attempts. Interruption owns setup
subprocesses as well as browser cleanup. If remote shutdown cannot be proved,
the runner retains its unique staging directory and records its removal condition
in `fleet-cleanup.json` instead of deleting files under a live process.

## Choose an install deadline

The default remains 180,000 ms for campaign phases. An explicit
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
	--timeout-ms=90000 --install-timeout-ms=nuxt:110000
```

The same options work with `run.ts` and explicit native WebDriver endpoints.
The fleet controller forwards the override unchanged to its native controller.
`--install-timeout-ms` accepts comma-separated `framework:milliseconds` pairs.
Each framework must be in the goals catalog. Each duration must be a decimal
integer from 100 through 900,000. Unknown frameworks, duplicate pairs, empty
entries, and repeated flags are errors. An override applies to that framework's
install phase across selected browsers and engines. It does not change cache
behavior or other frameworks, and no Nuxt override is enabled implicitly.

Reports use schema 2. `TABLE.json` records the effective install deadline for
every framework, the campaign deadline, and the fixed cleanup deadline in
`deadlines`. Each phase records its own `timeoutMs`, checked against that policy
when the report is read. `TABLE.md` shows the command and effective deadlines.
Continuation and shard combination reject different effective policies, even
when source and asset identities match. An explicit override equal to the
campaign deadline has the same effective policy as no override.
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
