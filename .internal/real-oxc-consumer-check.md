# Run the published Oxc consumer through a shared group

Status: Approved. The source runner is ready for matched producer inputs. Runtime
acceptance is pending. This check does not qualify Nuxt or later Oxc worker use.

Run from this checkout after the parent supplies a matching QuickJS group core,
its adjacent `quickjs.wasm`, the native launcher, and a Browser-engine control guest:

```sh
source env.sh
bun /work/heavy-runner/current/run.js --class light --host local real-oxc-consumer -- \
  bun scripts/real-oxc-consumer.ts "$GROUP_CORE" "$LAUNCHER" "$BROWSER_GUEST" "$RESULT_JSON"
```

Set each path explicitly. The driver never builds or downloads a guest. It fails
on a missing or mixed split/group pair before starting an install. Artifact source
matching remains the producer handoff's responsibility. Synthetic decoder tests do
not establish that matching or qualify a runtime.

The driver copies `tests/real-oxc-consumer` into private scratch and runs a genuine
`install --frozen-lockfile` with the selected group guest. It never asks the host
package manager to resolve Oxc. The fixture's four files match the authoritative
Nuxt handoff byte for byte, including its guest-generated lock and Oxc 0.94.0 pin.
The installed stock loader and official Wasm binding remain unedited.

The native group and Browser-engine control each run `/index.ts` and `/direct.ts`
on that same installed tree. Package parsing must print `ExportNamedDeclaration 0`.
The direct control must load the official binding and construct the unchanged
shared Memory descriptor with 4000 initial pages and 65536 maximum pages.

The driver then passes the installed tree to
`web/tests/shared-wasm-memory-browser.ts` through `SHARED_WASM_OXC_TREE`.
That existing runner stages every directory and file, including nested scoped
packages, binary Wasm, JSON, and CommonJS loaders. Its inventory lives outside the
copied tree. The page recreates the tree at `/` and runs the unchanged entries
through `startRun`, the production broker, and the production worker. Both natural
exit statuses and exact outputs must pass. Every observed group must retire and
release its budget. No pool, group policy, loader, or Memory descriptor changes.

Symlinks and special files fail staging rather than being omitted or dereferenced.
The current page filesystem API has no symlink creation operation. If the actual
guest-installed Oxc tree contains one, report that failure. Do not rewrite it into
a different tree. Source staging tests use synthetic files, not an installed Oxc
package, and do not claim this case has passed at runtime.

Each native or Browser-engine command keeps the original 90-second limit. Each
Oxc Browser-host entry also has a 90-second limit, within the existing runner's
300-second overall limit. The aggregate Browser fixture keeps its existing
240-second per-entry limit and unchanged clean/debt assertions. Its discovered
qualification rejects Oxc selection, so this opt-in driver cannot replace either
aggregate entry. Diagnostic overrides and `NAPI_RS_FORCE_WASI`, even empty, fail
the Oxc driver. The driver writes observations for started commands to `RESULT_JSON` on failure
and removes its scratch after its child exits. Signal cancellation reaches the
child before scratch teardown.

Source checks require no guests, browsers, or Oxc installation:

```sh
source env.sh
bun /work/heavy-runner/current/run.js --class light --host local real-oxc-source -- \
  bun test scripts/fixture-tree.test.ts scripts/real-oxc-consumer.test.ts \
    scripts/shared-wasm-memory-browser-qualification.test.ts web/tests/fixture-tree.test.ts
bun scripts/migrations/discover-checks.ts --check
```

The staging script test belongs to Web and local-runtime discovery. The Oxc
selection test belongs to Quality. The page inventory test uses Web's existing
automatic directory discovery. No new runtime CI gate is claimed: adding the
matched Browser control and launcher handoff to that gate is outside this bounded
source unit. The existing shared-group producer and aggregate owners are unchanged.
