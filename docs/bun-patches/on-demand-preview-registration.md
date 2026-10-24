## On-demand preview registration

`web/src/preview.ts` is an original bun-wasm adapter over the public
`waffle/browser/preview` and `waffle/browser/service-worker` APIs at the unchanged
Waffle pin `b20fad173ebaa225cb87c51776f35edaaafd4a40`. No upstream implementation
was copied or changed. Its constructor no longer registers the preview scope.
The first `ready` read registers that scope and caches the promise, including a
failed or unsupported outcome. Existing callers await it before opening a preview.
Module loading still registers its separate scope during page startup.

`web/tests/browser-preview-loading{,-main}.ts` are original request regressions
using the actual built service worker on Chromium and WebKit, at root and nested
mounts. They reject a preview registration or second service-worker download
before preview use and retain shared readiness and both eventual registrations.

`scripts/browser-preview-loading.test.ts` is original check glue. Its
`checks/web-browser-preview-loading.json` manifest gives the unchanged browser
regression one blocking owner without editing shared test commands.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [On-demand preview registration](#on-demand-preview-registration) | Host feature | Original page adapter registers its independent preview service-worker scope only when readiness is requested. |

[Ledger scope and pinned revisions](scope.md).
