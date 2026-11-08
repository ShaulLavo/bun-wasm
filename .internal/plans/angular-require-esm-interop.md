# Angular required-module imports

Status: Approved. PR 548 depends on the exact module metadata fix in PR 542.

The actual browser guest reproduces `import_child.default is not a function`
when CommonJS requires an ES module which imports a default ES function. Bun's
external-import conversion uses Node-mode CommonJS defaults for an actual ES
namespace. Genuine Chrome Angular reaches the same path in ansi-regex.

The scoped printer hook only runs during internal esm_to_cjs conversion. It
calls the existing fresh metadata object's namespace importer. ES dependencies
keep their cached namespace; genuine CommonJS dependencies keep their complete
exports as default. Public bundler calls do not enable this hook.

The failing actual-guest control landed first in ec596406c. Both loader modes
must pass default and live named imports, namespace identity, CommonJS values
and existing metadata controls. Public bundler output before and after the
conversion must remain byte-identical. Then run all three Angular Chrome
lifecycle cells at unchanged 90000 ms bounds.

Evidence and cleanup belong to
`/work/reports/goals/astro-angular/angular/`. The parent owns independent review,
CI and merge. No goals-matrix, executor, package or Firefox changes are in scope.

## Split namespace marker follow-up

PR 552 develops on exact PR 548 head
`9cdb73b4abe198df309a3cbd783111bafa52f2ac`. The QuickJS and JSC
`native.requireEsm` namespaces lack native Bun's inherited, non-enumerable
`__esModule` marker. The fix belongs only at that namespace handoff. A cached
live-getter view leaves explicit marker exports and CommonJS values unchanged.
The feature-owned native fixture covers QuickJS; the existing blocking JSC
web-guest group runs the same fixture on the actual split JSC guest.

### Existing browser differences, not part of PR 552

The unchanged browser core from exact `9cdb73b4` has SHA-256
`034a38b67f29a413f5d24ebf8b3ca9ffe81559cab715dfcde75a1ba0c1844a7d`.
Its internal bundled require path already differs from native Bun in namespace
reflection, required versus dynamically imported module state, and explicit
`__esModule` exports. The namespace marker follow-up must not expand that path.
The existing browser default-import, metadata, and public bundler controls stay
unchanged. A later browser interop task can use this reproducer.

From the repository root after `source env.sh`, with that browser core in `dist/`:

```sh
code='const n=require("./default.mts");n.increment();console.log(n.__esModule,Object.hasOwn(n,"__esModule"),Object.prototype.toString.call(n));const m=await import("./default.mts");console.log(n.count,m.count,n.default===m.default);console.log(require("./marker.mts").__esModule);'
bun --cwd tests/fixtures/require-esm-namespace-marker -e "$code"
node --no-warnings web/scripts/node-host.mjs --wasm dist/bun-browser.wasm \
  --dir "$PWD/tests/fixtures/require-esm-namespace-marker::/" \
  --env PWD=/ --env HOME=/ -- -e "$code"
```

Native Bun 1.4.4 prints `true false [object Module]`, `1 1 true`, and `false`.
The unchanged browser guest prints `true true [object Object]`, `1 0 false`, and
`true`. This reproduces without Angular or its dependencies. Full output is
`/work/reports/goals/astro-angular/split-marker/browser-differences.log`.

### Later split-engine Angular failures

One Chrome attempt per split engine used the fixed core from
`39f5b3f7206911d33a70d585e18a04105b89aab9`, unchanged retained engine sides,
and the unchanged 90000 ms phase bounds. Both install successfully. QuickJS
installs in 55.751 seconds, reaches a preview URL, then times out in dev. Its
terminal reports `The object cannot be cloned` during shutdown, with exit 130.
JSC installs in 25.262 seconds and exits dev after 2.776 seconds with
`Maximum call stack size exceeded`, exit 127. Neither terminal contains the old
`yargs_1.default` error. Click, hot reload, build, and preview are not reached.
These are observations, not a root-cause diagnosis or a full-cell pass.

The exact matrix command is recorded in
`/work/reports/goals/astro-angular/split-marker/chrome/TABLE.json`; the matching
per-engine terminal logs are in its `logs/` directory. Asset hashes and source
are in `split-marker/asset-source.json`. Both actual split guests pass the
focused namespace fixture and nearby CommonJS controls, so the namespace marker
is no longer the first blocker. The parent owns diagnosis of the later failures.
No further Angular attempt was made by this worker.
