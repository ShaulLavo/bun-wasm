# Server framework browser coverage

Targeted Chromium evidence recorded on October 21, 2026, against guest source
`c4794d69cdeb8f2c80593ec5d601a00c0c8b8705` and Waffle
`f6017d12f59c81dae75eece5a6cb62c0470d166e`.
This is not a full app census or a framework conformance claim.
The historical scoreboard snapshots are unchanged.

| Unmodified npm package | Guest install | Browser preview requests |
| --- | --- | --- |
| Express 5.1.0 | Pass | Pass |
| Koa 3.0.1 | Pass | Pass |
| Fastify 5.6.1 | Pass | Pass |
| Hono 4.10.2 | Pass | Pass |
| Elysia 1.4.13 | Pass | Pass |

Each fixture installs its real dependencies into a fresh guest filesystem with
`bun install`. The offline registry verifies cached object hashes. Package names,
versions, and entry points are checked before execution. No package is patched.
The browser-native engine executes the server through Waffle, not a host Node
server or the Node-hosted browser-engine launcher.

## Checked behavior

Each server passes root-page text and six further HTTP requests:

- Two route-parameter and query-string requests return different JSON values.
- A JSON POST echoes the submitted fields and returns HTTP 201.
- Malformed JSON returns HTTP 400.
- A missing route and an unsupported method each return HTTP 404.
- Middleware echoes a fresh random request header on all six responses.

The expected route, query, body, and header values change on every run.
Root-only text, fixed JSON, success responses on negative routes, missing headers,
and wrong statuses fail the regression tests.

The root response must come from the service worker, and the preview page must
have a service-worker controller. Fetches run inside that page. After the guest
stops, the same preview must return Waffle's HTTP 502 unavailable response.
The runner operates in a loopback-only network namespace and blocks external
browser requests. It starts only a static asset server and the cached registry.

Koa core does not include a router or body parser. Its fixture matches the route
and parses the request stream in application middleware. Its malformed-JSON
handler returns an explicit 400 response. Koa's default thrown-error handler clears
application headers, so the fixture does not claim those headers survive it.

These checks do not establish persistence, streaming, WebSockets, every error
path, or embedded-engine compatibility. Native matrix rows retain their existing
root-response check. The extended request checks apply to literal-browser rows.
Next.js is outside this test.

## Evidence

The local report root is
`/work/reports/bun-wasm-frameworks-20261021/server-browser`.
`final/results.json` records ten passing install and start rows.
The five `final/*-requests.json` files record 30 request and response pairs,
including bodies, statuses, headers, and random challenges.
The five `final/*-stopped.json` files record the post-stop 502 responses.
Terminal logs and five preview screenshots sit beside them.
`final.log` records zero registry misses or errors and successful scratch cleanup.

The unchanged browser guest SHA-256 is
`5e37d2afc8d73da8544ba4c1ac32d6c899b85ce1b2325892dd8aa9dcbc4a53bb`.
It was downloaded from the verified live playground rather than rebuilt from a
stale local distribution. The web host was built from this checkout with frozen
lockfile dependencies.

See [the replay procedure](server-browser-replay.md) for the regression command.
