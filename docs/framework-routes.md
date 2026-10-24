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

Keep one fixture `bun.lock`. Do not copy native `.next` output into the guest. The exact-version `@next/swc-wasm-nodejs` dependency lets Next load its compiler without querying npm for a missing fallback. Run the compiler probe before Next startup or build.

```sh
# Stage only missing tarballs named by the fixture lock. No package is patched.
bun web/tests/next-framework-registry.ts "$SCRATCH/registry" examples/frameworks/bun.lock
NEXT_WEB_ROOT="$PLAYGROUND_DIST" \
NEXT_GUEST_WASM="$BASELINE_GUEST" \
NEXT_REGISTRY_EXTRA="$SCRATCH/registry" \
NEXT_REPORTS="$REPORTS" \
bun web/tests/next-framework-browser.ts
```

This baseline measurement requires the supplied guest digest `5e37d2afc8d73da8544ba4c1ac32d6c899b85ce1b2325892dd8aa9dcbc4a53bb`, built from c4794d69. `NEXT_WEB_ROOT` points to the matching built playground. The runner verifies the raw guest and the build receipt. `NEXT_WEB_PORT` and `NEXT_REGISTRY_PORT` default to43220 and43221; choose free explicit ports. Use a short `TMPDIR` for Chromium. `PLAYWRIGHT` can select the installed package entry.

The app-matrix registry mirror is read-only. The supplemental mirror downloads exact locked tarballs and checks SHA-512 integrity. The guest frozen installer also requests foreign-platform optional tarballs, so stage the whole lock, not just native Linux packages. Browser runs never fetch npm directly.

Reports separate install, compiler, dev, build and start. A failed compiler blocks the server/build checks. Start requires a guest-created `.next/BUILD_ID`. A timeout or blocked stage makes the runner exit nonzero. Zero app-matrix rows are not a pass. The runner closes its context, browser, registry and static host. It never disposes a pre-existing application runtime, publishes an app, or changes a deployed site.

## Measured baseline

On c4794d69, the pinned native control passed dev, production build and production start. Chromium exercised five framework mutations, independent backend lists, dynamic Next API POST/GET, status/headers, server rendering, hydration, navigation, reload and assets. Native dev HMR passed. Partial-start rollback, repeated close and the five-second forced stop passed.

The literal browser replay reached an earlier installation blocker. With the complete locked mirror and no cache misses or external requests, frozen install exited1 with `No space left on device (os error 51)` while installing `@sinclair/typebox@0.34.52`, after several platform-optional SWC packages hit the same error. The real SWC WASM15.5.6 compiler had already installed and its TypeScript transform probe passed. Browser dev, build and start remain blocked, not supported. There was no static export, copied native build output, package patch or host application server.

A repeat recorded1,070,792,704 allocated bytes out of the1,073,741,824-byte filesystem limit, with41 occupied shared slots. Storage, not the shared identity-table count, blocked this install. The locked installer requested Darwin, Windows and foreign-CPU optional binaries on the browser guest. Keep those packages unchanged and rerun this fixture after that capability is fixed. Reaching this boundary does not verify Next IPC, loopback rewrites, service-worker Next navigation or browser HMR.
