# Run the framework matrix

Build the playground with `source env.sh && bun web/build.ts`. Supply matching
engine pairs through the build's existing environment variables, or copy a
recorded delivery's WASM files into the new build. Keep the actual WASM source
identity separate from the playground source commit.

Run all 260 boxes:

```sh
source env.sh
bun scripts/goals-matrix/run.ts --asset-source=/absolute/delivery-manifest.json
```

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
uses Playwright Firefox. Native desktop Safari and native iPhone simulator Safari
use real WebDriver endpoints configured with `--safari-endpoint=http://…` and
`--iphone-endpoint=http://…`. `--device-udid=…` selects the claimed simulator.
Playwright WebKit and mobile emulation are not accepted browser names. Reserve the
Mac and simulator through the fleet workflow before starting the endpoints.
Missing engines, assets, templates, or native endpoints remain not runnable yet
with their discovery evidence. A browser or guest that starts and fails is a
failed attempt with its first concrete phase error.
