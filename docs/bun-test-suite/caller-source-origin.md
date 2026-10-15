# Caller source origin

`bun:jsc.callerSourceOrigin()` returns the calling file's URL using the runtime's existing
stack parser. It handles helper modules, CommonJS, encoded filenames, native callbacks,
resumed async functions and timers. There is no engine-independent Bun implementation to reuse.
Bun's implementation walks JSC call frames directly.

WebKit's browser engine omits source locations for eval code, even with a `sourceURL`
directive. CommonJS uses eval in the browser host, so that case returns `null`. The adapter
stops at the opaque frame instead of reporting the importing ES module's URL. The browser
check asserts this limit explicitly. ES modules work in WebKit; CommonJS origins also work
in QuickJS, wasm JSC and the Node host.

## Upstream measurement

The [83-file selection](caller-source-origin-files.txt) comes from the checked-in baseline's
first errors mentioning `callerSourceOrigin`. Before the fix, every file stops at that
missing import. Removing this import blocker exposes further API gaps and does not yet
increase the number of fully passing files.

| Engine | Caller-origin import blockers before / after | Fully passing files before / after | Observed passes before / after | File timeouts before / after |
| --- | ---: | ---: | ---: | ---: |
| QuickJS | 83 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Browser host | 83 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Wasm JSC | 83 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

The wider QuickJS control includes 135 files. Both runs have 9 fully passing files,
218 observed passes and zero timeouts. The target group changes from 83 synthetic failures
and 83 errors to 94 failures and 81 errors. One bake file now registers thirteen failing
shell tests. These are newly observed failures, not lost passing tests.

The next runner blocker appears at `test/bundler/expectBundled.ts:123`, which calls
`Bun.jest(file)`. That call appears in 62 target-file excerpts. Bake's separate dev-server
API gaps remain with its lane. `js/bun/jsc/bun-jsc.test.ts` next requires the private
`describeArray` export.

Both sides use Bun source `4ceda2c2868d3a7703c7737ddd9de7244ec384df` plus checked-in patch
`0009`, the same pinned hoisted dependencies, loopback networking, one worker, a 15-second
file deadline and a 2-second initial test deadline. The QuickJS comparison changes only the
wasm hash in provenance. The baseline wasm was copied before building the new runtime.

## Reproduce

Build all three engines and install dependencies as described in [the suite guide](README.md#reproduce).
Then run the fixed selection for each engine:

```sh
source env.sh
mapfile -t files < docs/bun-test-suite/caller-source-origin-files.txt
scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-caller-source-origin-quickjs.json "${files[@]}"
```

Repeat with `--engine browser` and `--engine jsc`, using separate output paths. The local
fixture is `scripts/test.sh --no-build --engine <engine> caller-source-origin`. The real
Chromium and WebKit check is part of `scripts/test-web.sh`.

## Opaque eval regressions

`caller-source-origin-eval` invokes an eval-created function from another module,
direct eval and a Function constructor. Each must report its creation module or `null`.
It must never report an unrelated invocation module or a pseudo filename such as `<input>`.
When public call-site metadata exposes the eval origin, the test requires the actual creation
module and rejects `null`. This prevents replacing every eval result with `null`.

The stack formatter preserves V8 eval creation metadata and keeps opaque eval frames
distinct from native callbacks. The builtin excludes its own capture frame, which also lacks a source URL in WebKit,
then stops at an unidentified user frame instead of skipping it. QuickJS rejects its `<input>` placeholder as an origin. JSC retains its
honest `null` when the engine omits the source.

Before the fix, QuickJS and the browser host fail the cross-module case; wasm JSC
already passes with `null`. Immutable published artifacts at `fe674cf` reproduce those
results. The existing native-callback fixture also covers V8 Array.map frames, which
have neither a file nor the native flag but are not eval frames.

Native Bun 1.4.2 falls back to the invocation module for the cross-module Function
constructor control. This manual fixture follows the stricter requested contract and
accepts only the creation module or `null`. Review evidence is retained in
`/work/tmp/bun-wasm-track4-review/` until coordinator acceptance.
