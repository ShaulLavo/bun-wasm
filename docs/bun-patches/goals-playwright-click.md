# Goals Playwright trusted clicks

Class **Host feature**, **original test adapter** in
`scripts/goals-matrix/transport.ts` and `native-click.ts`. No upstream code is
copied or adapted, so there is no upstream path or revision.

The Chrome and Firefox goals transports implement the existing `nativeClick`
capability with Playwright's mouse input. A trial locator click waits for
actionability without sending the click. Admission is checked again before
mouse input, so a cancelled actionability wait cannot send a late click.
The first selector match is used consistently with the witness's
`querySelector`, including pages that add an unrelated Dev Tools button.
Mouse coordinates use the viewport-visible part of the target, checked by
hit testing before input, so partly offscreen counters remain clickable.
The selected host or preview page
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

The shared `native-click.ts` document guard reports the first failed predicate
as `state-missing`, `token-mismatch`, `url-mismatch`, or `time-origin-mismatch`.
Its existing evaluation error carries only literal boolean evidence for the
comparisons reached before failure. Later comparisons remain unevaluated. No
token, URL, time origin, selector or page content is added to the diagnostic.
The generated function stays self-contained for both transport callers. Target
and trusted-event checks, serial Safari dispatch, admission and cancellation
are unchanged. This distinguishes guard failures, not their reload or session
cause, and adds no browser command, poll, retry or deadline.

`checks/quality-goals-native-click.json` owns generated-source short-circuit and
falsy-state controls. The existing Safari transport fixture checks error
propagation, and `checks/web-browser-goals-safari-click.json` owns actual DOM
controls in Linux Chromium and WebKit for all four document failures, valid
input, target identity and trusted-event boundaries. No guest or framework is
needed for these controls.
