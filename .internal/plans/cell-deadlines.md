# Per-cell campaign deadlines

Status: Approved. Owner decision: November 11, 2026.

Use a reviewed, fixed policy keyed by framework, browser and engine. Calibrate
each category from the latest complete passing attempt in the frozen canonical
cell and its history, ordered by actual finish time and then start time. Apply
12.5% margin, rounded up to integral milliseconds. The shared phase category
uses the maximum startup, dev, render, click, hot-reload and preview duration.
Install and build use their corresponding durations. Cleanup stays 20 seconds;
existing inner bounds stay unchanged. No passing attempt means unchanged defaults.
In-guest engines can tighten but cannot widen. Next on SpiderMonkey is exempt,
including its lane's deliberate CLI overrides.

The generator is an explicit maintenance command, never part of campaign
execution. Runtime lookup consumes checked-in policy data. CLI phase and install
overrides remain explicit and recorded, and fleet forwards only supplied flags.
Reports validate per-cell effective limits and reject resume across policy
changes. Historical reports retain their original policies and attempt bytes.

Frozen input: `/work/reports/goals/chrome-firefox/cell-deadlines/INPUT.json`.
SHA-256: `96ebe1aba8032b12dc9e3077a9bad97f5e9c4967fd970d7cbc3b4e1bbf822ad2`.
It contains 208 cells and 112 current passes. Canonical reports are immutable
implementation inputs. A separate explicit metadata application tool will let
the coordinator update only top-level policy metadata and the Markdown deadline
section after review and merge, preserving outcomes, histories and identities.

Verification uses the existing runner and transport fixtures, focused policy
tests, script types, lint and check discovery. It requires no native guest build
or full framework matrix. Tests own temporary servers and scratch cleanup.

## Reproduce the fixed policy

```sh
source env.sh
bun scripts/goals-matrix/calibrate-deadlines.ts \
  /work/reports/goals/chrome-firefox/cell-deadlines/INPUT.json \
  scripts/goals-matrix/cell-deadlines.json --check
bun scripts/goals-matrix/calibrate-deadlines.ts \
  /work/reports/goals/chrome-firefox/cell-deadlines/INPUT.json \
  /work/reports/goals/chrome-firefox/cell-deadlines/LIMITS.md --markdown
```

The frozen data produces 112 calibrated cells, 92 with no complete pass and four
exempt Next/SpiderMonkey cells. Chrome and Firefox Next Browser builds change
from 110,000 ms to 25,072 ms and 43,168 ms respectively. Shared phases change
from 90,000 ms to 4,926 ms and 5,692 ms. Install changes from 90,000 ms to
19,782 ms and 20,059 ms. Every category uses the same selected complete attempt.

## Apply canonical metadata after review and merge

The coordinator runs this from the merged source, with exclusive ownership of
canonical table writes for the whole recipe. Pause canonical merges first.
Use a fresh staging directory on each attempt:

```sh
source env.sh
stage=/work/reports/goals/chrome-firefox/cell-deadlines/metadata-stage
bun scripts/goals-matrix/policy-metadata.ts /work/reports/goals "$stage"
sha256sum --check --strict "$stage/before.sha256"
```

If any checksum fails, discard staging and start again from current canonical
files. Do not apply individual stale files. After all three checks pass:

```sh
for name in TABLE.json VIEW.json TABLE.md; do
  cp -- "$stage/$name" "/work/reports/goals/$name.policy.tmp"
done
for name in TABLE.json VIEW.json TABLE.md; do
  mv -- "/work/reports/goals/$name.policy.tmp" "/work/reports/goals/$name"
done
sha256sum --check --strict "$stage/after.sha256"
```

Resume canonical merges after the final checks. The tool changes only the
top-level `campaignPolicy` field and the bounded Markdown Deadlines section.
The existing `deadlines`, source, commands, timestamps, cells, histories, phase
timeouts and outcomes stay intact. `campaignPolicy` describes future execution.
The existing external merge helper preserves that BASE metadata and slices
the updated deadline section on later merges. TABLE.json and VIEW.json must
agree when staging. Staging never writes to its inputs.

Remove the staging directory after application and checksum verification. Keep
the frozen input, LIMITS.md, source policy and verification logs for review.
Ordinary campaign invocations omit `--timeout-ms`; an explicit uniform flag
deliberately overrides calibration and appears in policy metadata. Historical
report commands and independent lane overrides remain recorded as run.
