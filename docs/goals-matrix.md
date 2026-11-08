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
pending, never pass. `--timeout-ms=180000` bounds each phase. `--resume` continues
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
