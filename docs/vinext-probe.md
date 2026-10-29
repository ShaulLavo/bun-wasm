# Probe vinext on QuickJS

The fixture reduces vinext's Pages Router example to its SSR home and counter,
using the documented Node target. It pins vinext 1.4.0 and Vite 8.3.4. Next
acceptance remains a separate task.

Run from a dedicated checkout with its root and web dependencies installed.
Use an existing playground build, including matching `bun.wasm` and
`quickjs.wasm`. Do not build another engine pair for this probe.

```sh
source env.sh
extra=$(mktemp -d /work/tmp/bun-wasm-vinext-registry-XXXXXX)
trap 'rm -rf "$extra"' EXIT
export TMPDIR="$extra"
bun web/tests/next-framework-registry.ts "$extra" examples/vinext-probe/bun.lock
bun /work/platform-production/heavy/current/run.js --class browser vinext-probe -- \
  bun scripts/app-matrix/vinext-probe.ts \
  --web-root /ABS/EXISTING_PLAYGROUND_BUILD \
  --registry-extra "$extra" --output /ABS/NEW_REPORT_DIRECTORY \
  --runtime-label historical-or-verified-producer-identity
```

The driver uses the existing app-matrix playground staging, with a loopback-only
registry and explicit virtual port 3137. It installs the lockfile's packages,
starts Vite dev, checks a real page, edits and restores the source through HMR,
navigates again to check reload, clicks the counter, builds, and runs
`vinext start`. A failed build blocks start. A failed dev server blocks its
page/edit checks. Missing registry archives fail the run. No downgrade or
framework substitution occurs.

`run.json`, `results.jsonl`, and the terminal log hold results. Exit 1 means a
failed/blocked cell or infrastructure failure. `canonical: false` is intentional:
this bounded driver hashes distributed bytes but does not verify the engine
producer manifest. Compare a current run with the producer's receipt before
claiming current-source acceptance. An old guest failure is historical evidence.

Install uses the shared driver's `bun install`, not a frozen-install gate.
The source lock's hash and dependency versions are recorded; guest platform
metadata may be rewritten. This does not establish frozen-lock compatibility.

[Upstream source and local changes](bun-patches/vinext-probe.md).
