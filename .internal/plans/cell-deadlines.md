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

The authority is `/work/reports/goals/CAMPAIGN-POLICY.json`. It retains the
existing owner decisions, including Next/SpiderMonkey, and stores the reviewed
policy at `cellDeadlines`. TABLE.json and VIEW.json receive that complete
authority object as `campaignPolicy`, so subsequent ordinary merges preserve it.

Before publication, the coordinator installs the shared writer protocol from
merged source. Copy `scripts/goals-matrix/canonical-write.ts` to
`/work/reports/goals/canonical-write.ts` and apply
`.internal/plans/canonical-merge-writer.patch` in `/work/reports/goals` after
checking it against the current helper. If its context changed, reconcile the
same small wrapper before proceeding. Verify the installed lock module matches
the merged source. This changes no merge selection or outcome logic: the helper
holds `.canonical-writer.lock` for its existing read/merge/write operation and
refuses to write while an unfinished publication marker exists. Do not replace
the helper or its lock module during an active canonical write.

The publication and recovery commands hold the same OS lock. Tests and PR
merges continue normally; canonical writes serialize without a human permission
token. `flock` is required on the canonical Linux host and releases its lock
when the holder exits, including process interruption.

Every writer of any of the four canonical files must use this same protocol,
including ad hoc edits to owner decisions in CAMPAIGN-POLICY.json. Hold
`.canonical-writer.lock` across the complete fresh read/modify/write operation
and call `assertNoPublication` before writing. Preserve unrelated authority
fields, including `cellDeadlines`; never write an old snapshot over another
owner's newer decision. A checksum alone does not serialize a writer that
ignores this advisory lock.

Use a fresh staging directory:

```sh
source env.sh
stage=/work/reports/goals/chrome-firefox/cell-deadlines/metadata-stage
bun scripts/goals-matrix/policy-metadata.ts /work/reports/goals "$stage"
sha256sum --check --strict "$stage/before.sha256"
```

Staging reads and checksums all four canonical files and saves recoverable
originals under `$stage/originals`. It writes nothing to those inputs. An
unfinished publication must be recovered before staging another update.

Apply the complete set with the executable publisher, not shell copy loops:

```sh
bun scripts/goals-matrix/policy-metadata.ts --apply "$stage"
sha256sum --check --strict "$stage/after.sha256"
```

The publisher rechecks every original, generated file and backup while holding
the writer lock, copies and verifies all four temporary files before promoting
any, and checks every final hash. A failed copy or rename restores the complete
original set before returning the failure. A stale-input failure writes nothing:
remove that unused staging directory and stage again from current canonical data.

An interruption or failed rollback leaves
`.campaign-policy-publication.json` with the staging location. Ordinary merges
refuse to write until recovery succeeds. Keep the staging directory and run:

```sh
bun scripts/goals-matrix/policy-metadata.ts --recover "$stage"
sha256sum --check --strict "$stage/before.sha256"
```

Recovery restores all four originals and removes the marker and owned temporary
files only after verification. Then create a fresh stage if publication is still
needed. Recovery refuses to overwrite an unexpected third-party change: preserve
the complete current set and backups, reconcile that new evidence under the writer
lock, and do not resume ordinary merges while the marker remains.

The changes are limited to authority metadata, the top-level `campaignPolicy`
fields and the bounded Markdown Deadlines section. Original `deadlines`, source,
commands, timestamps, cells, histories, phase timeouts and outcomes stay intact.
The new metadata describes future execution, not retroactively executed limits.

Remove the staging directory after application and checksum verification. Keep
the frozen input, LIMITS.md, source policy and verification logs for review.
Ordinary campaign invocations omit `--timeout-ms`; an explicit uniform flag
deliberately overrides calibration and appears in policy metadata. Historical
report commands and independent lane overrides remain recorded as run.
