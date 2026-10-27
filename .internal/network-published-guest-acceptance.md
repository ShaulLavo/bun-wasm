# Published guest network acceptance

2026-10-23. Receipt preflight passes; browser acceptance is blocked.

PR #103 already replaced the single reviewed hash with an explicitly supplied
artifact, its adjacent `.build.json` receipt, and independent accepted build
inputs. This check uses that implementation unchanged. The original reviewed
hash evidence is not a claim about the published artifact below.

## Selected inputs

The generated descriptor names SHA-256
`6d2c90d4adba7a964c819b63f44ea54b3f91478106b3a7c90722546380f8adfc`,
15,180,188 decompressed bytes. The existing PR #84 artifact and its sidecar match.
No guest was rebuilt, downloaded, replaced or published for this check.

The independent accepted-input file comes from the retained PR #84 exact-merge
build record, not from the selected sidecar:

```json
{
  "bunHead": "d0ff70f675291230dfaddd03b458d67028d2e050",
  "bunTree": "cfa11e0011e8c48f6b9e458ef02d3b5ee2cae05b",
  "sysrootReceiptSha256": "1b34055631be4bae6202e10ed845be9856adc03dae9e9c23f1a019d01463bf2f"
}
```

The original repository build commit is
`7bc7ba3760991d50e7c067f91076d7c9b11d7761`. The original build record is
`/work/reports/bun-wasm-pr84/exact-merge-browser.json`. The vendor source commit's
tree and current retained sysroot receipt digest were also checked directly.
Root, web and sandbox manifest/lockfile Waffle pins all remain
`fc58a532f0d7a617e631ea4b7580a190915d4ed6`, version 0.0.58.
No bash-web package participates in this gate.

## Reproduce

Use an exclusive checkout and the host's browser queue. Set an explicit free
port. Keep the expected-input file separate from the guest sidecar.

```sh
source env.sh
NETWORK_CONSUMER_GUEST=/absolute/bun-browser.wasm \
NETWORK_CONSUMER_EXPECTED_INPUTS=/absolute/accepted-inputs.json \
NETWORK_CONSUMER_PORT=43961 \
  bun web/tests/browser-network-consumer.ts chromium firefox webkit
```

Set `NETWORK_CONSUMER_PREFLIGHT_ONLY=1` to check identity without browser setup.
The rejection controls run both preflight-only and normal entry with an invalid
port and no browser cache. Missing receipt, changed bytes, wrong source/build
inputs, invalid byte count and missing expected-input file all fail at the
receipt boundary, with no setup output or scratch changes.

## Observed browser results

The source at `0a8af762c5a2be60b43ce188640c0258c7552437` ran all six combinations
on upcloud-4, Playwright 1.64.1, using cached Chromium 1248, Firefox 1555 and
WebKit 2370. The command exited 1, not a passing network acceptance.

| Browser | prepare | publicAdapter |
| --- | --- | --- |
| Chromium | Child IPC unsupported | Stream returns HTTP 500; guest reports array-buffer allocation failure |
| Firefox | Child IPC unsupported | Stream fetch raises NetworkError |
| WebKit | Child IPC unsupported | Browser target crashes during the stream check |

All three `prepare` failures report `ERR_NOT_SUPPORTED_IN_WASM` at the parent
`Bun.spawn` call. The selected guest's source predates merged IPC PR #98.
At its build commit, `crates/bunwasm-runtime/src/js/spawn.ts:187` explicitly
rejects `options.ipc`. Current source supports IPC. Do not remove IPC from the
scenario to admit the older guest.

In that run, each `publicAdapter` scenario reaches the stream check after HTTP
preview, service-worker routing and WebSocket echo assertions. The streamed-response
implementation is also older than the accepted newer local candidate; that
candidate's PR #103 matrix is separate evidence, not a substitute here.

Five scenarios report zero owned workers and listeners after disposal. The
crashed WebKit page cannot provide that receipt. Browser/context closure and
remote teardown remove the remaining processes, listener, profiles, staged
source and staged artifacts. The borrowed local guest and sidecar are unchanged.

The full cloud source/control suite passed 103 tests before the matrix. Evidence,
including failed results and verified teardown, is retained under
`/work/reports/machine-fleet/remote-gate/bun-network-published-r2-20261023T054629Z-6ocz__m5/`.
Selection and local controls are under
`/work/reports/wave-20261022/bun-wasm/network-published-20261023/`.

A final-source repeat at `ba0d15dd464537617f96c559f8105774125abc06` also
attempted all six combinations and exited 1. IPC, Chromium stream HTTP 500 and
Firefox stream NetworkError failures repeated. WebKit crashed earlier in that
repeat: preview returned HTTP 404 and the owner page could not provide
diagnostics or cleanup counts. The driver retains the original assertion
failure alongside the failed cleanup, rather than replacing it with a diagnostic
error. The other five page cleanup receipts again report zero workers/listeners.
Final evidence is
`/work/reports/machine-fleet/remote-gate/bun-network-published-final-20261023T055143Z-354bjm4k/`.
Independent actual-host readback found no owned processes or staged paths.
