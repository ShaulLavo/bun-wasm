# SpiderMonkey G0/G1 receipt refresh

Status: blocked. Source checked at `845ef3a16033de7d5d8c6bdadd9d682e1c0dd7fc` on November 1, 2026.
PR 452 remains the only delivery target. This records a partial repair, not completion.

The checker changed after the historical G1 build. The final receipt and replay
still identify the previous checker. The archive, all object files, generated
support recipes, source checkout, and `config.status` were removed by that run's
teardown. Re-running the existing checker exits 1 with `ENOENT` for
`/work/tmp/bun-wasm-spidermonkey-final-TmwhlK/obj/clangd/compile_commands.json`.
Saved manifests alone cannot reproduce archive packing. No receipt field or hash
was hand-edited, and no current-head G1 receipt was produced.

## Verification

The following focused checks passed on the source head above:

- `bun test scripts/spidermonkey-build.test.ts scripts/test-checks.test.ts`,
  26 passes, zero failures, and 578 assertions.
- `tsc --ignoreConfig --noEmit --module nodenext --target esnext --strict
  --allowImportingTsExtensions --skipLibCheck --types bun
  --typeRoots /work/projects/bun-wasm/node_modules/@types
  spidermonkey/check-build.ts scripts/spidermonkey-build.test.ts`.
- `oxlint --deny-warnings spidermonkey/check-build.ts scripts/spidermonkey-build.test.ts`.
- `bash -n spidermonkey/*.sh` and `bun scripts/test-checks.ts quality --list`.
- `git diff --check` and `git diff --check dac56d021c2a1eb342612f2bd3621ac95fda5264 HEAD`.

`source env.sh` preceded all checks. TypeScript and oxlint used the existing
`/work/projects/bun-wasm/node_modules/.bin` tools. No dependency install occurred.

Detailed evidence remains under
`/work/reports/wave-20261031/engines/spidermonkey-g0-g1/`:

- `REPORT.md`, `pr.json`, `unit-tests.log`, and `source-checks.txt`.
- Unchanged historical `final/vm-library.json` and `final/check-replay.json`.
- `refresh/recipe-audit.json`, `refresh/historical-receipts.sha256`,
  `refresh/checks.sh`, `refresh/run.txt`, `refresh/pack-check.stderr.log`,
  and `refresh/cleanup.txt`.

## Size and cleanup

The historical full checkout was 1,601,328,791 logical bytes. The unchanged
budget is 1,500,000,000 bytes, so the size gate exceeded its budget by
101,328,791 bytes, or 6.76 percent. A source-only count is not a replacement.
Coordinator disposition remains required before later gates.

The refresh scratch was removed. No original build input remains available.
Only small report files and this note were added. No native or WASM rebuild,
G2, runtime integration, app run, M1, or JIT work ran.

## Recovery

Authentic retained build inputs would allow the existing checker to regenerate
the receipt and replay. Otherwise a separately authorized fresh G1 build is
required. Do not replace a historical hash to make the audit appear current.
