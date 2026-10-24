# Remaining TCP compatibility checks

Status: Approved, queued under track 4 of
[real Bun on our engines](real-bun-on-our-engines.md).

The TCP transport, HTTP upgrade, published ws exchange, and Node common loading
checks are implemented. [The measured results](../tcp-results.md) retain
later failures. This queue addresses public compatibility beyond those working
paths. Keep private-field assertions separate from user-visible failures.

## Socket read callbacks and reconnect options

Reproduce without changing upstream files:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
bash /work/tmp/wave-heavy/run.sh --class light "net reconnect probe" -- \
  env PATH="$PATH" scripts/bun-suite.sh --network loopback --jobs 1 --timeout 60 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-net-reconnect-new.json \
  js/node/net/socket-reconnect-live.test.ts
```

At upstream `ddab8382bdf6b02f22653758d901fb83ceb85aa8`, the paused reconnect case
still reaches its two-second test timeout. The other two cases pass after this
PR. The child fixture uses `onread: { buffer, callback }`; `Socket._receive` in
`crates/bunwasm-runtime/src/js/node_net.js` currently implements stream delivery
only. The connect factory also constructs Socket without forwarding constructor
readable/writable options. Trace those together before adding another read
path. Preserve pause, reference state, byte counts and closure of the old handle.
The existing raw Node test file has only a 15-second file budget and can time
out after advancing beyond its earlier missing-export collection error.

## Server constructor and default-address contracts

Use the same command with `js/node/net/server.spec.ts` and a fresh output path.
The measured QuickJS run has 27 passing, 13 failing and three skipped cases.
Failures include legacy callable construction, function arity, invalid option
types, the default IPv6 any address, and private instance fields. The adapter
binds IPv4 any by default; native hosts can already bind explicit IPv6.
Browser connections currently report virtual IPv4 endpoints.

Compare the constructor and listen contracts against Bun's `src/js/node/net.ts`
at the pinned revision. Prefer the planned Bun module switch when its socket
and stream hooks are available. Do not invent private worker/counter fields to
make reflection tests pass. The original adapter is needed because that module
still depends on private stream modules and native Bun socket hooks.

## Other first blockers

`js/bun/net/socket-dns-error.test.ts` still has host and diagnostic edge cases.
Reproduce its exact inputs with the same isolated command before changing DNS
normalization. The Rust host and Node engine host own resolution; browser raw
internet TCP remains unavailable.

TLS and Unix socket files need capabilities beyond this plain TCP adapter.
`socket.test.ts` and syscall-fault files first import private `createSocketPair`
or `socketFaultInjection` hooks. TLS files can stop on the unrelated RedisClient
export. The half-open comparison launches a native Node executable, which our
child ABI deliberately cannot run. These first blockers do not establish that
all later assertions need the same fix. Preserve them in the compatibility
campaign rather than posting new issues.

## CLI preview port isolation

Status: Done, 2026-10-23.

The helper now allocates a separate real loopback port for each guest listener
and reports that actual preview URL. The mapping stays keyed by guest port.
`bun test web/tests/cli-preview.test.ts` first failed with EADDRINUSE when a
real listener occupied the guest port. After the fix, two independent helpers
serve that same guest port without touching the existing listener. Teardown
stops both previews and the test binds their real ports again.

The following is the historical reproduction:

During the round-two TCP gates, `scripts/test-web.sh` failed ten CLI fixture
comparisons with an extra diagnostic:

```text
[preview] port 49152: Error: Failed to start server. Is port 49152 in use?
```

The guest assertions still produced their expected output. All 24 web unit
tests and the Chromium/WebKit checks passed. The complete failing run is
`/work/reports/bun-wasm-tcp-fanout-2026-10-16/tcp-web.log`. No listener or
TIME_WAIT connection using 49152 remained when inspected afterward, so the
identity of the conflicting binder is unknown. This was observed once; the
retry is recorded separately in that report.

Inspect `web/scripts/net-helper.ts` in `serve(port)` and the `EPHEMERAL_BASE`
allocation in `web/src/net/host.ts`. The CLI helper binds the guest virtual port
directly on the real host, including guest-selected ephemeral ports. Concurrent
CLI helpers therefore share that host namespace. Give automatic guest listeners
isolated host ports while keeping external preview URLs correct. First force
a collision in an isolated fixture, then verify both helpers and their teardown.
Do not stop another session or mask the diagnostic in fixture expectations.

## Same-size HMR update timeout

Status: Approved for bounded reproduction if the timeout recurs.

The main-integration gate at code commit 20f9684 timed out once in
`web/tests/browser-net.mjs:259` after replacing the HTML app text with an
identically sized string. Both HMR sockets connected, but neither preview
observed the update within 15 seconds. No source or artifact change was made;
the next complete web run passed that check on all six browser/engine pairs.
The failed and passing runs are retained in
`/work/reports/bun-wasm-tcp-main-2026-10-16/tcp-{6,7}/web.log`.

Reproduce after building the web assets with `ENGINES=browser node
web/tests/browser-net.mjs chromium` from the repository root, through the
browser heavy slot. Keep repeats bounded to five and retain WebSocket frame
and file-change observations if it fails. Inspect the same-size edit in
`checkHtmlEntry`, the helper's changeFile ring delivery and the worker's file
update callback. No cause is established; preserve the 15-second assertion
and the file-size control rather than increasing the timeout.
