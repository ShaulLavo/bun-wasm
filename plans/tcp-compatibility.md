# Remaining TCP compatibility checks

Status: Approved, queued under track 4 of
[real Bun on our engines](real-bun-on-our-engines.md).

The TCP transport, HTTP upgrade, published ws exchange, and Node common loading
checks are implemented. [The measured results](../docs/tcp-results.md) retain
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

## Framework commands after ws import

The complete [offline replay](../docs/app-matrix/ws-results.md) uses integration
`f7659376c594a5f6f6bf7a8035be69a5b23a2281`. Recreate it
from the TCP/ws branches plus Rollup prerequisite
`97e67614b2a4cd6eaca6d8ef339ce1af30252802`, then use the exact two replay commands
in that report. All 18 installs pass, but the 33 complete commands still fail.

Vite vanilla/React/Vue builds on QuickJS and JSC now reach esbuild's native
binary selector at `node_modules/esbuild/lib/main.js:1651` with
`Unsupported platform: linux wasm32 LE`. This affects six native build rows.
SvelteKit's config-bundling stack reaches the same selector without printing
its message. Establish a bounded esbuild API/official wasm-package control
before choosing the replacement; no framework source was changed in this run.

Astro's QuickJS log stops at the circular `Fragment` export in
`node_modules/astro/dist/runtime/server/index.js`. JSC reports the missing
`Http2ServerResponse` export from `node:http2`. Browser-engine commands retain
the known method named import rewrite in `engine_host.rs`; the Rollup report
already has its minimal reproduction. Coordinate that work with the module
loader lane rather than duplicating its edits.

Vite dev commands have empty native logs. Playground Vite React exits zero
before any HTTP/DOM assertion. No root cause is established. Trace module
handoffs and pending entry promises around `run_event_loop` in
`crates/bunwasm-runtime/src/lib.rs:389`; its no-work branch deliberately allows
unsettled top-level await to exit quietly. Do not replace that behavior with a
warning and claim the app is fixed. The raw logs, original result JSON and
classification-only correction are retained under the report's evidence path.
