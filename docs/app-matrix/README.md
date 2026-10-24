# App matrix records

Measurement records for the [compatibility page](../compatibility.md). This directory is tool-owned, not hand-written documentation: `scripts/app-matrix.sh` produces the data, `bun scripts/refresh-compatibility-docs.ts` regenerates the tables in `compatibility.md`, and `scripts/app-matrix/reclassify.mjs` writes `classifications.md`. The paths are hard-coded in those scripts.

- [compatibility.md](compatibility.md): the full run log, in order, with reproduction commands. Read the generated "Current full replay" section for the latest result and treat earlier sections as history.
- `measurements/2026-10-17/*.json`: the raw snapshots the generated tables read.
- Per-package notes: [esbuild](esbuild-results.md), [Rollup](rollup-results.md), [framework exits](exit-provenance.md), [server in the browser](server-browser.md), [classifications](classifications.md).

Paths such as `/work/reports/...` in these files are the recording machine's, not yours.
