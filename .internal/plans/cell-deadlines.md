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
