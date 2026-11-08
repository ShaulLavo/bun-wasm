# SpiderMonkey framework runner

Status: Approved. The goals runner follows the actual playground engine registry for
registration, status names and core filenames. Paired side filenames come from the
shared engine profiles. This includes explicitly selected SpiderMonkey without
registering Hermes, changing the default selector, or changing supported publication.

A missing whole engine is still a discovery result, not a runnable cell. A staged
partial pair is a preparation error. Both SpiderMonkey files participate in the
embedded-host, manifest and byte fingerprint check. Asset preparation includes the
optional pair before the ordinary playground build embeds its fingerprints.

`source env.sh && bun test scripts/goals-matrix/engines.test.ts` covers discovery,
plain/compressed assets, cleanup, partial pairs, stale bytes, and running status.
All four tests fail before the runner correction against the actual registered
SpiderMonkey source, not a replacement loader.

Development evidence belongs in
`/work/reports/goals/engines/spidermonkey-frameworks/`. The canonical goals table
remains frozen and owned by its existing lane. Retained SpiderMonkey components
have separate core and side source identities; a current host build is not a
current full guest build. No release, JIT or general parity claim follows from
these runner corrections.

## November 8 framework evidence and remaining work

The normal current playground host at `c56fdfecc` used the retained common core
from `df0cad1085bc76295858760b8d45f27980b0f15a` and side from
`20dd3513ff5eafe7806d934578385827062f632f`. Google Chrome
`157.0.8103.38`, not Chromium, ran the maintained runner with its original
180,000 ms phase clocks and the ordinary shell, registry install and templates.
The original complete attempts are in `history/initial-c56/TABLE.json` under the
separate report directory above. No canonical table was changed.

Hono installed `hono@4.10.2` and started its dev listener, then hit the render
clock. One targeted response capture found HTTP 200 with `[object HTMLBundle]`
instead of the page source. The exact native Bun reference returns a string for
`import page from './page.html' with { type: 'text' }`; both retained SpiderMonkey
and retained JSC return the bundle object and fail the same assertion.
Reproducer: `text-import-control.sh` and `text-import-repro/` in that report.

Next loader action: carry the import's requested loader through resolution and
module identity before `crates/bunwasm-runtime/src/modules.rs:436` chooses
`Format::Html`. `ModuleHost::resolve/load` currently carries no attributes.
`bootstrap.js` consequently creates an HTMLBundle. Add a regression importing
one HTML file both normally and as text, including dynamic import, without
aliasing their cached identities. This is shared runtime work, not a
SpiderMonkey JSAPI change. Do not bypass it by changing Hono's template.

Vite React installed all 24 configured packages, then failed to load its normal
Rolldown WASI binding because SpiderMonkey had no SharedArrayBuffer global.
Its default realm disables shared memory and Atomics. Enabling that existing
JSAPI realm option fixes the maintained `shared-array-buffer` fixture, which
failed before with ReferenceError and passes afterward without changing its
cross-guest DataCloneError expectation. Standard Atomics store/add/load also
passes. Only the small adapter side was rebuilt against the unchanged Mozilla
archive. The shared core and normal supported guests were not rebuilt.

The ordinary host rebuilt at `c9afec99f` stages the new side and records separate
component origins and fingerprints in `components.json`. One changed-side Vite
attempt reaches the next concrete cause, `Shared WebAssembly memories are not
supported`. The installed binding is present. The runtime deliberately throws
this in `crates/bunwasm-runtime/src/js/webassembly.ts:90`, and
`web/tests/webassembly-memory.test.ts` asserts that rejection. The first binding
error and all nested causes remain in the final table and terminal log.

Next WebAssembly action: start with a minimal imported shared Memory/Instance
fixture using one guest. Design the actual memory identity, growth and host
views before adding support to the generic guest WebAssembly API. Merely
removing the rejection or substituting an unshared memory would be wrong.
This requires shared runtime work beyond this runner and realm increment.
Neither framework cell is green. Render, click, HMR, build and preview assertions
were not relaxed, and no unchanged full-cell retry followed either dependency.

Minimal next-dependency reproducer:
`.internal/reproducers/shared-wasm-memory.ts`. Native Bun prints
`shared WebAssembly memory 65536`. The retained core with the corrected
SpiderMonkey side throws the deliberate shared-memory LinkError before a module
is instantiated. This file is not registered as a passing runtime fixture.
The Engines parent owns the separate main CI compiler-control repair, review,
final rebase, CI and merge. Its deferred-native-destruction test hunk is unchanged
here; the SpiderMonkey semantics test addition covers only realm configuration.
