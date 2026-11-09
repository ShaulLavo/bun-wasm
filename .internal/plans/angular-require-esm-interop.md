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
`__esModule` marker. The original fix used a cached live-getter view at the namespace handoff.
The review below rejected that view because it changed identity and branding.
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

## Remaining conditional-resolution gap

Independent review found a pre-existing gap outside wrapped static imports.
A required ES module using `import {tag} from 'dual'` or `export {tag} from 'dual'`
selects the package's `require` condition. A namespace import selects `import`.
This reproduces in store and records modes, each with hooks and native contexts.
Expected output for the named import and re-export is `import-tag`; actual output
is `require-tag`. The unwrapped printer branch already behaves this way at the
assigned base, so this is not caused by the new scoped wrapper.

The retained reproducer is
`/work/reports/goals/astro-angular/angular/review-548/condition-forms.ts`.
Stage a browser guest as `<scratch>/bun-browser.wasm`, then run
`bun /work/reports/goals/astro-angular/angular/review-548/condition-forms.ts "$PWD" <scratch>`
from a source-qualified worktree after `source env.sh`. The script materializes
its conditional package and removes that fixture. Its four outputs distinguish
named, namespace, named re-export and side-effect import forms. Investigate the
internal printer's unwrapped static import and re-export paths without changing
explicit CommonJS require conditions. Keep the current PR claim limited to
wrapped static imports. This follow-up is not a proven Angular goal blocker.

## Rejected wrapper review blockers

Independent review at `f401db6429f25f185ada4b11847cd62d72d01381` reproduces
two regressions on the actual QuickJS and JSC guests. A require-only getter
view is not identical to the dynamic-import namespace or a namespace re-export.
Its non-null prototype also fails the current namespace-recognition predicate.
The pre-change split namespace and native Bun pass both controls.

That wrapper revision remained blocked. Preserve the actual canonical namespace and its live
exports across require, dynamic import, and namespace re-export, rather than
relaxing the identity or recognition tests. Native Bun exposes its marker on
a namespace prototype and still recognizes the namespace by its engine brand.
A correct fix may need native namespace construction support; the original
require-only wrapper is not a sufficient solution.

Exact reproduction is in
`/work/reports/goals/astro-angular/split-marker/review-552/namespace-probe.sh`,
with outputs in `identity-reexport.log`. The actual native fixture now asserts
identity and namespace recognition, retaining all earlier marker checks.

## Native canonical namespace correction

Status: Approved. PR 552 replaces the rejected wrapper with engine-created
namespace prototypes. No per-require view or identity map remains. QuickJS keeps
`JS_CLASS_MODULE_NS`; JSC keeps `JSModuleNamespaceObject` and changes its initial
structure prototype in the embedding helper. Both inherit the non-enumerable
marker while own exports stay live. Bootstrap uses the native VM brand when
supported and retains the old predicate only for an unsupported capability.

The retained actual QuickJS and JSC guests both fail the strong committed
fixture at `/index.ts:21` before the correction. The original marker, default,
CommonJS, live-export, identity and reexport checks remain. Added controls cover
static-first and dynamic-first loading, empty namespaces, fabricated Module-tag
objects, borrowed prototypes, and proxies that must not execute user traps.

Native Bun 1.4.4's import-first namespace gains the marker only when required.
The approved native creation design exposes it earlier, but keeps the same
canonical object. Tests compare native Bun's marker after require, not before.
Source tracing, design comparison, commands and actual guest logs belong to
`/work/reports/goals/astro-angular/native-namespace/`. The parent owns independent
review, integration, CI and merge. Later Angular stack and shared-buffer failures
remain separately owned, not reasons to retry full installations here.

### Native implementation results

Both rebuilt native guests pass the expanded namespace fixture and
`cjs-interop`, `default-import-reexport`, `esm-create-require`, and
`module-prototype-require`. The existing JSC Node-host test passes too.
The rebuilt browser guest passes those four adjacent controls and the unchanged
interop, metadata and public-output checks in both module modes. Native Bun 1.4.4
passes the expanded fixture after the import-first marker timing is accounted for.

Local runtime preflight passes 1,498 tests across 103 files. Source-control tests,
check discovery, lint, runtime/package/web/sandbox/script type projects, unused
checks, duplicate checks and the feature-version guard also pass. The first
preflight exposed missing hoisted Node type definitions; reinstalling the existing
frozen dependencies with `--linker hoisted` repairs that setup. A run under an
overlong TMPDIR hit the existing browser-root guard and was stopped. The final
preflight uses the normal short `/work/tmp` and passes. No product assertion,
deadline or fallback was relaxed.

The new implementation still needs the parent's fresh independent review and
normal CI. PR 552 stays draft. No new Angular Chrome install was run because the
independently owned later stack and shared-buffer blockers are still open.
