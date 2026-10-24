# Bun upstream test-suite records

Measurement records for the [compatibility page](../compatibility.md). This directory is tool-owned, not hand-written documentation. `scripts/bun-suite.sh` runs the suite, `scripts/bun-suite-report.py` and `bun scripts/refresh-compatibility-docs.ts` write the reports and tables here, and the scripts hard-code these paths. `dependencies/` is a live install tree used by CI and tests.

- [results.md](results.md): measured scope, provenance, per-directory tables, commands, and limits. Start here.
- [triage.md](triage.md) and [failures.tsv](failures.tsv): first blocker of every failing file.
- [investigations.md](investigations.md): regressions, timeout controls, and ranked next fixes.
- `*.json`, `*.tsv`, `*-files.txt`: raw snapshots and fixed file selections the scripts read.

Paths such as `/work/reports/...` in these files are the recording machine's, not yours.
