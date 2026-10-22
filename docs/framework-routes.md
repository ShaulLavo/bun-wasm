# Next routes to five frameworks

`examples/frameworks` is one Bun process with six loopback listeners. Next15.5.6 serves the UI and its own dynamic API. Its rewrites send `/api/express/*`, `/api/koa/*`, `/api/fastify/*`, `/api/hono/*` and `/api/elysia/*` to unchanged Express5.1.0, Koa3.0.1, Fastify5.6.1, Hono4.10.2 and Elysia1.4.13 packages. React and React DOM are19.1.1. Each framework owns a separate in-memory list.

## Run the native control

Use Bun1.4.2, as pinned in the fixture. From the repository root:

```sh
source env.sh
cd examples/frameworks
bun install --frozen-lockfile
bun run dev
```

Visit `http://127.0.0.1:43100/framework/express`. Add a note, switch frameworks and reload. Restarting the process resets notes. Production uses `bun run build` followed by `bun run start`. Build does not need running backends. Ports43100 through43105 must be free. Native listeners bind only127.0.0.1.

The host-only control also needs the repository's `web` development dependencies, including Playwright and its installed Chromium. Run these from the repository root under the host's job runner:

```sh
bun web/tests/next-framework-native.ts express
bun web/tests/next-framework-native.ts dev
# Stop dev before building. Both modes own .next.
(cd examples/frameworks && bun run build)
bun web/tests/next-framework-native.ts prod
bun web/tests/next-framework-native.ts cleanup
(cd examples/frameworks && bun test lifecycle.test.ts)
```

`NEXT_REPORTS` selects the report directory. The control checks real POST/GET bodies, independent state, query parsing, middleware rejection, status/headers, invalid IDs, request-time rendering, hydration, Next Link/RSC navigation, reload and assets. Dev additionally checks a source edit through Next's HMR WebSocket and restores the source. Cleanup mode exercises the five-second forced process-group stop against a real child that ignores SIGTERM. Lifecycle tests check partial startup rollback, repeated close and preservation of an unrelated listener.

## Browser-native measurement

The dedicated runner uses the existing playground's one Waffle runtime and the Browser native engine. Only a static host and an offline package mirror run on the host. Application listeners run inside the guest. Browser pages enter through the Waffle service-worker preview, and the contract checks that transport explicitly.

Keep one fixture `bun.lock`. Do not copy native `.next` output into the guest. The exact-version `@next/swc-wasm-nodejs` dependency lets Next load its compiler without querying npm for a missing fallback. Run the compiler probe before Next startup or build. The fixture `.env` explicitly selects `NEXT_TEST_WASM_DIR=./node_modules/@next/swc-wasm-nodejs`, read by Next itself. This is the exact installed15.5.6 compiler, not a package modification. Published Next15.5.6 otherwise converts a bare compiler package name to a cwd file URL and fails discovery on native Node too. The setting is Next's shipped, unstable testing hook; reassess it when changing Next versions. Separate require, bare dynamic-import and resolved-file-URL diagnostics remain mandatory so the explicit selection cannot hide a guest module-import failure.

```sh
# Stage only missing tarballs named by the fixture lock. No package is patched.
bun web/tests/next-framework-registry.ts "$SCRATCH/registry" examples/frameworks/bun.lock
NEXT_WEB_ROOT="$PLAYGROUND_DIST" \
NEXT_GUEST_WASM="$SELECTED_GUEST" \
NEXT_GUEST_SHA256="$SELECTED_GUEST_SHA256" \
NEXT_REGISTRY_EXTRA="$SCRATCH/registry" \
NEXT_REPORTS="$REPORTS" \
bun web/tests/next-framework-browser.ts
```

Select an explicit guest path and SHA-256. `NEXT_WEB_ROOT` points to a playground built from the current checkout with that same guest. The runner verifies its raw build receipt, declared digest, host engine receipt and decompressed distributed bytes independently. It also compares complete fixture manifest and lock bytes before and after frozen installation and compiler probing, under the unchanged1GiB filesystem cap. `NEXT_WEB_PORT` and `NEXT_REGISTRY_PORT` default to43220 and43221; choose free explicit ports. Use a short task-owned `TMPDIR` for Chromium. `PLAYWRIGHT` can select the installed package entry.

The existing `/work/cache/bun-wasm-app-matrix` registry is read-only. The supplemental mirror downloads exact locked tarballs and checks SHA-512 integrity. Stage the complete lock for deterministic offline availability. The mirror contents do not imply that the installer requests every optional platform package. Browser runs never forward live requests to npm. The fixture also sets `NEXT_TELEMETRY_DISABLED=1`, supported by published Next15.5.6. Its dev update check still requests `https://registry.npmjs.org/-/package/next/dist-tags`. The browser runner intercepts only that exact GET URL and serves pinned `{"latest":"15.5.6","canary":"15.5.6"}` metadata from its injected offline registry policy. These are fixture values, not current npm tags. Each interception records the requested URL, local response URL, provenance, and response SHA-256 in `offlineMetadata`. Neighboring paths, queries, hosts, and methods remain denied. All other external requests abort and fail the run. This test-only policy does not change runtime network defaults.

Reports separate install, compiler, dev, build and start. A failed compiler blocks the server/build checks. Start requires a guest-created `.next/BUILD_ID`. A timeout or blocked stage makes the runner exit nonzero. Zero app-matrix rows are not a pass. The runner closes its context, browser, registry and static host. It never disposes a pre-existing application runtime, publishes an app, or changes a deployed site.

## Measured baseline

On c4794d69, the pinned native control passed dev, production build and production start. Chromium exercised five framework mutations, independent backend lists, dynamic Next API POST/GET, status/headers, server rendering, hydration, navigation, reload and assets. Native dev HMR passed. Partial-start rollback, repeated close and the five-second forced stop passed.

The October21 replay from merged6bd66574 with corrected guest8f0228da passed actual Chromium frozen install of214packages and the real SWC transform. The complete52,751-byte lock and849-byte manifest remained unchanged under the1GiB filesystem cap. Direct require, bare dynamic import and resolved-file-URL compiler transforms all passed. The prior installation storage blocker is therefore cleared for this run.

The October21 r8 replay uses guest SHA-256 `391f1f499a790bd032a83a7d5d3aacf980951fe1a2aa3a24287f2b4f5bf8bbdf`. The Module._compile, filesystem stream, raw stdout/stderr cursor, and VM fixtures pass in Chromium. Frozen214-package installation and all compiler import diagnostics pass. The actual guest production build completes in38.17seconds, including type checking, four static pages, traces, and finalization. It creates BUILD_ID `zYETa3Su3vyOGUKZkVUCN`. The earlier r5b missing-stream and cursor failures no longer block that build.

Dev still times out at the original30-second preview navigation deadline. Production start opens its listener and begins HTTP200, but its response fails with `this._implicitHeader is not a function` in unchanged Next compression. It also times out without a complete page. The HTTP response correction is source-tested separately and still needs a corrected-guest replay. Neither the build nor the source tests establish application acceptance.

The application root is isolated at `/home/user/next-framework`; probes remain outside it. Complete lock and manifest bytes and the1GiB capacity remain unchanged. One exact Next dist-tags request receives pinned offline metadata, with no external egress. No browser hydration, navigation, rewrite, HMR, or production-start acceptance is claimed. No static export, host application server, copied native build output, package patch, cache disabling, or TypeScript-config rename was used.
