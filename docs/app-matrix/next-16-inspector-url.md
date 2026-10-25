# next-16-app: no-debugger inspector state query

Status: Approved. This is a single-feature blocker record for the `next-16-app` browser
baseline; it is not a shared compatibility snapshot.

## Observed blocker

- Baseline: `/work/reports/bun-wasm/product-matrix-20261025/baseline-priority/`
- Browser guest source: `af6cced2ce5fa2212458b2b2e69784c7108a37fc`
- Baseline harness/main repair: `72d1394484dcd64b051f63f230ad70bfaf2769ae`
- `next@16.4.3` install passed, then dev/build reached
  `inspector.url is not supported in bun-wasm: no debugger`.

## Feature contract

| API | No attached debugger in Node/Bun | bun-wasm contract |
| --- | --- | --- |
| `inspector.url()` | returns `undefined` | returns `undefined` |
| `inspector.close()` | returns `undefined` | returns `undefined` without a server |
| `inspector.open()` | starts debugger transport | remains `ERR_NOT_SUPPORTED_IN_WASM` |
| `inspector.waitForDebugger()` | checks active debugger state | remains `ERR_NOT_SUPPORTED_IN_WASM` |
| `new inspector.Session()` | constructs a session | remains `ERR_NOT_SUPPORTED_IN_WASM` |

No debugger URL, active session, transport, server, or OS capability is synthesized. Waffle
continues to own any future debugger boundary.

## Verification

The focused fixture is `tests/fixtures/node-inspector-state/`. Its expected output is hand-written
because native `inspector.open()` would start a debugger server. Verify it with the cached launcher
or an artifact built from this commit; do not use the feature record as evidence for a full Next
build or browser campaign.
