# Goals Playwright trusted clicks

Class **Host feature**, **original test adapter** in
`scripts/goals-matrix/transport.ts` and `native-click.ts`. No upstream code is
copied or adapted, so there is no upstream path or revision.

The Chrome and Firefox goals transports implement the existing `nativeClick`
capability with Playwright's locator click. The selected host or preview page
receives browser input instead of the playground's DOM `.click()` fallback.

The shared witness was moved from `safari-click.ts` without weakening its
checks. Both Playwright and Safari require a trusted event on the armed button,
the same document and target, and the original zero-to-one counter change.
The existing phase admission bounds readiness, native input and observation.
Input is sent once. A failed native click never falls back to synthetic input.

`checks/web-browser-goals-playwright-click.json` owns focused Chrome and Firefox
controls through the real `checkClick` path. They use tiny HTML counters and
need no guest build or framework installation. Safari retains its existing
browser controls and transport fixtures. Framework templates, phase limits
and acceptance assertions are unchanged.
