# Trusted Chrome bootstrap quarantine

Status: Approved. Owner: Speed round 2 coordinator.

Only the genuine Chrome case in
`scripts/goals-matrix/playwright-click-browser.test.ts` is skipped when `CI=true`.
This is a quarantine of Chrome coverage, not a successful Chrome result or a
correction to browser startup. The skip and a GitHub warning make it visible.
Outside CI, that exact case still runs. Bundled Playwright Chromium and Firefox
both run the entire shared control sequence as blocking tests, including trusted
input on host and preview, wrong targets, disabled and synthetic input, partial
visibility, covered targets, cancellation, deadlines and browser-process teardown.

Every case still includes bootstrap in its original 30-second budget. The
`10-interface` shard remains limited to 143 seconds. No launch flag, retry,
production transport behavior or logger default changes.

The decisive failure is PR 739 run 43560048629, job 132342734620, synthetic merge
`4f3d6dd49f207b9f91f8c3ded9a21833dbd99269`, merging
`1a14d04140b5e0f6609cfe04a4113738224f548e` into
`aa4b7a50e44533cf91f90cf6deb78560bb6f59c8`. Embedded monotonic records place
Chrome server launch at 0.558–22,178.374 ms, context readiness at 22,917.035 ms,
and initial page readiness at 29,922.412 ms. Navigation starts at 29,922.915 ms;
the 30-second whole-case timeout ends the browser before any click control runs.
Phone controls pass and the shard ends at 128.48 seconds. This is not a shard
overrun or a click assertion failure. The Chrome version is not reported by this
failed launch; its requested channel is `chrome`. Playwright is 1.64.1 and Bun is
1.4.4. Preserve that distinction from earlier exact-version local controls.

The complete failed log and prior exact-version controls are retained at
`/work/reports/wasm-performance/own-cost-speed/ci-post735-click/`.

Remove this quarantine when a supported Chrome bootstrap correction has a normal
hosted run of the unquarantined genuine Chrome case and the full interface shard
passing within the unchanged 30-second and 143-second budgets. Restore the case
by deleting its CI skip and warning. Keep the bundled Chromium control coverage.
The speed coordinator owns this removal and the retained evidence.
