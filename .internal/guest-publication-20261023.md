# Default browser guest publication, 2026-10-23

The previous default, `6d2c90d4adba7a964c819b63f44ea54b3f91478106b3a7c90722546380f8adfc`,
predated the current guest implementations of `fs.readv` and `fs.readvSync`.
Changing the host package did not update the downloaded Wasm guest.

## Build identity

The replacement browser guest was built at `5fa3a24f` using the normal browser
build entry point and its unchanged sidecar receipt. It has 15,234,118 uncompressed
bytes and SHA-256 `e63f4b4fe731881f14b75b5491a36f41fbe1edef5f6c2fc1a0cf20454cb6d2f3`.

```json
{
  "bunHead": "d71508d31edf06765c12adf0df137ef531539f68",
  "bunTree": "cfa11e0011e8c48f6b9e458ef02d3b5ee2cae05b",
  "sysrootReceiptSha256": "1b34055631be4bae6202e10ed845be9856adc03dae9e9c23f1a019d01463bf2f"
}
```

The source-input check was repeated against base `56d2dd3c`, including #106 which pinned
Waffle 0.0.67. No Rust, Cargo, imported Bun patch, guest build script or sysroot
builder changed between these revisions. The installed Waffle builder and libc
patch hashes still match the sysroot receipt, and `build-wasi-sysroot.ts` verifies
all recorded SDK, tool, environment and libc inputs. A package revision alone is
not a guest build input. No receipt was regenerated or inferred.

## Publication

Use the existing [publication flow](../docs/guest-publishing.md), not a mutable site
asset or release attachment. The publisher checks all three matching guest
builds through its interruption matrix before authenticated storage access.
It created the browser guest's deterministic gzip object in the existing
`bun-wasm-guests` R2 bucket, then verifies the public decompressed body, headers
and CORS before generating `src/guest-asset.generated.ts`.

Only the browser guest is published. QuickJS and JSC are explicit opt-ins.

Uploaded at 07:01 UTC to the existing bucket, with no release attachment,
mutable site asset, new bucket or new host:

```text
bun-wasm-guests/e63f4b4fe731881f14b75b5491a36f41fbe1edef5f6c2fc1a0cf20454cb6d2f3/bun.wasm.gz
```

The gzip object is 5,126,478 bytes. Its metadata is `application/wasm`,
`Content-Encoding: gzip` and
`Cache-Control: public, max-age=31536000, immutable, no-transform`.
Authenticated storage access and public read-back passed. An independent request
with `Origin: https://example.com` and `Accept-Encoding: gzip` returned HTTP 200,
`Access-Control-Allow-Origin: *`, the same gzip size and the exact decompressed
hash and size above. The previous immutable object was left untouched.

The interruption matrix ran on the Mac with its job lock, using the existing
`acceptGuestPublication` function. Its three browser receipts bind every compiled
buffer to the snapshot hash and size. All browsers passed and the runner reported
safe cleanup. The Mac lock was released at 06:45:38 UTC. No Cloudflare credential
was transferred to the Mac. On the PC, `acceptedPublicationArtifact` checks those
receipts against the matching local snapshot before `publishGuest` uses the
existing R2 publisher and public read-back. This splits the same flow across
hosts without skipping an acceptance check.

## Acceptance

All checks use the same browser bytes and unchanged build receipt, with Waffle
0.0.67 installed from the PR base. No rebuild or old-guest fallback is involved.

- Full-build interruption gate: all three real engines pass in Chromium,
  Firefox and WebKit. Each browser compiles the exact receipt-bound artifacts,
  reports no page errors and disposes all owned workers.
- Generic process gate: 23 checks in each browser. Artifact-backed process gate:
  24 checks in each browser, using the matching QuickJS sibling.
- `runtime_proc`: all 20 scenario results pass in Chromium, Firefox and WebKit,
  including callback `readv` on process stdin and positioned/shared-cursor
  `readvSync`/`readv` on an inherited file.
- Network consumer: `prepare` and `publicAdapter` pass in every browser. This
  covers real preview service-worker HTTP, child WebSockets, streaming and
  cancellation, backpressure, isolation, port collisions and listener lifetime.
  Every page reports zero owned workers and listeners after disposal.

The initial Firefox startup-refusal control produced the correct process result
but failed its exact-message assertion because Playwright's console formatter
reduced the logged Error object to `Error`. The test page now converts Error
arguments to strings before logging. The expected diagnostic, missing/duplicate
rejection controls and uncaught-error assertions are unchanged. The isolated
startup-refusal control then passes in all three browsers.

Reproduction, from a checkout with the documented browser dependencies:

```sh
source env.sh
BUN_WASM_PROCESS_DIST=/path/to/full-builds \
  bun web/tests/browser-process.ts --artifact chromium firefox webkit
BUN_WASM_RUNTIME_PROC_ARTIFACT=/path/to/full-builds/bun-browser.wasm \
  bun web/tests/bun-runtime-proc-browser.ts chromium firefox webkit
NETWORK_CONSUMER_GUEST=/path/to/full-builds/bun-browser.wasm \
NETWORK_CONSUMER_EXPECTED_INPUTS=/path/to/independently-accepted-inputs.json \
NETWORK_CONSUMER_PORT=4287 \
  bun web/tests/browser-network-consumer.ts chromium firefox webkit
```

The accepted inputs JSON contains the three source fields listed above, selected
from the PR base independently of the artifact. Keep its `.build.json` beside the
guest. The network run used #109's all-scenarios driver at `8f4881a4`, with no assertion
changes. The merged driver is now available on the PR base.
