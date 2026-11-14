# Run the published Oxc consumer through a shared group

Status: Approved. The source runner accepts JSC, QuickJS and SpiderMonkey shared
profiles. Live acceptance still needs matching producer inputs. Development
Browser evidence does not qualify a native packet or Nuxt.

Run once per selected shared profile, with its matching adjacent engine side,
native launcher, and Browser-engine control guest:

```sh
source env.sh
bun /work/heavy-runner/current/run.js --class light --host local real-oxc-consumer -- \
  bun scripts/real-oxc-consumer.ts "$GROUP_CORE" "$LAUNCHER" "$BROWSER_GUEST" "$RESULT_JSON"
```

The core tag selects JSC, QuickJS or SpiderMonkey and its expected side filename.
For SpiderMonkey, set `BUN_WASM_SPIDERMONKEY_TIER=interp` or `pbl` explicitly. The
driver passes that tier to the native guest and the existing Browser-host runner.
It never builds or downloads a guest. Missing artifacts, split cores, mixed
profiles and incorrect side exports fail before installation. Matching the source
of all producer outputs remains the producer handoff's responsibility.

The driver copies `tests/real-oxc-consumer` into private scratch and runs the
selected guest's `install --frozen-lockfile`. Its lock pins official parser,
transform and minify packages and their WASI bindings at 0.94.0. The lock was
extended with host Bun's lockfile-only resolver and normalized to the existing
guest installer metadata rules. Transform's WASI fallback is a required dependency
in that lock, as parser's already was, and guest lock records omit `libc`. Public
package manifests and selection logic are unchanged. The live check still installs
with the guest and refuses changes to any fixture source or lock bytes. Package
loaders and binaries remain unedited. No force-WASI environment override is used.

A single consumer table defines package names, direct bindings, API methods,
filenames, source, options and semantic checks. Every execution checks:

- `index.ts` evaluates all three public packages through their stock selection
  logic and invokes their synchronous APIs.
- `direct.ts` separately requires each official WASI binding and invokes the same
  APIs. It also preserves the original shared Memory control with 4000 initial
  pages and 65536 maximum pages. Direct failures retain their inner exceptions.
- `async.ts` calls public `parseAsync` and `transformAsync`, verifies actual
  promises, and checks resolved output. Both calls start before awaiting results.
  Minify 0.94.0 exposes only its synchronous API.

Parser checks inspect the exported variable and its value in the public AST or
the direct binding's JSON envelope. Transform receives a TypeScript filename,
`cwd` and `lang` options, and must emit runnable JavaScript without its type
annotation. Generated transform and minify code must compute 42. Minify must also
shorten its input. Export existence alone cannot pass these checks.

The native group and Browser-engine control run every entry on the same installed
tree. A failed public command does not suppress the direct-binding or async
observations. Any failure still fails the driver. The installed tree then enters
`web/tests/shared-wasm-memory-browser.ts` through `SHARED_WASM_OXC_TREE`. That
existing runner stages every file and directory and uses the production Browser
executor. Exact outputs, natural exit, group retirement and budget release remain
required. Symlinks and special files still fail staging.

Native and Browser-engine commands retain their 90-second bounds. Browser-host
entries retain 90 seconds each and the existing 300-second overall bound. The
aggregate shared-memory qualification retains its 240-second entry bound and
clean/debt assertions. Its blocking check rejects Oxc diagnostic selection, so
this opt-in driver cannot substitute for the qualification gate. Overrides,
including an empty `NAPI_RS_FORCE_WASI`, fail before installation. Observations
are saved on failure, and signal cancellation stops children before scratch
teardown.

Source checks require no engines, browser, or Oxc install:

```sh
source env.sh
bun /work/heavy-runner/current/run.js --class light --host local real-oxc-source -- \
  bun test scripts/fixture-tree.test.ts scripts/real-oxc-consumer.test.ts \
    scripts/shared-wasm-memory-browser-qualification.test.ts web/tests/fixture-tree.test.ts
bun scripts/migrations/discover-checks.ts --check
```

`checks/quality-real-oxc-consumer.json` retains the source check's Quality owner.
Staging retains its Web and local-runtime owners, and the shared qualification
keeps its existing blocking owner and protections. No workflow command or new
runtime CI gate is added. Host API controls use report-only synthetic results;
they do not establish real addon success.
