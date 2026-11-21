# Storage preview routing observation

Classification: adapted implementation and original diagnostic adapters.

The private build transforms in `scripts/storage-routing-build-source.ts` adapt
Waffle's `browser/service-worker.ts`, `browser/preview.ts`,
`browser/net/helper.ts`, and `browser/net/runtime.ts` from release `0.0.136`,
revision `022d711d78ffbe6c9c6a45fe1bcbd2d970d09ce7`. These four source
files are byte-identical in release `0.0.137`, revision
`27b03a8c519b4d48d00d3723b4ee2993d735f27d`, and in `0.0.138`. In release
`0.0.139`, revision `8e86a2a0f2398c1485ef16f7bc423961f4e05f94`, only
`browser/net/helper.ts` changes: its preview finish sink ignores a second
`end` or `error`. The helper adapter's anchor and insertion are unchanged.
Selected release `0.0.142`, revision `38c0b979ae958fd5acb1b1819135096df0832d9b`,
keeps all four files byte-identical to `0.0.140` and `0.0.139`.
In selected release `0.0.144`, revision `cf9cdd8693d2e5e92494709e4734c29d87da0efb`,
only `browser/net/helper.ts` changes again: fetch reports Bun's redirect failures
under `redirect: "error"` (Waffle PR 565). The helper adapter's anchor and
insertion are unchanged. Selected release `0.0.145`, revision
`21f5ad1f38dd3c3d3b346a7cfaf955e8139831ea`, keeps all four files
byte-identical to `0.0.144`.
The exact installed source hashes and unique insertion anchors reject drift or
incomplete installations. No provider source is edited.

The transforms reuse the qualified preview-claim observer and its schedule
controls from the Storage investigation. The actual-consumer extension also
reuses the earlier Sandbox runtime/router and helper/projection hooks. Consumer
hooks adapt this repository's `web/src/preview.ts` and `sandbox/src/sandbox.ts`.
The consumer source starts at bun-wasm revision
`ff8697a55094e8e5485d78619037d070f12a90d1`. The earlier qualified observer
implementation is retained in bun-wasm commit
`9c987b08fa2c4d1b540967f7037b67ed5ec5a23a`.
They add scalar observations around original calls, without changing request
payloads, ports, candidate ordering, receivers, return values, thrown errors,
or the original 3000 ms claim deadline. Page send-before-call and send-return
are separate events. SW reply records expose response status, first body progress
and terminal chunk totals, never header values, file contents or body bytes.

Original adapters are `scripts/storage-routing-build.ts`,
`scripts/storage-routing-collector.ts`, and
`scripts/storage-routing-evidence.ts`. The existing storage diagnostic build
flag enables them. Ordinary deployed builds omit them. Scalar SW batches use a
separate diagnostic message type; original preview messages remain unchanged.
The queue holds at most 256 rows; the host retains at most 4096 routing rows and
128 target request observations, independently of filesystem causal retention.
Every overflow is counted. No retained row contains a Request, MessagePort,
runtime, filesystem tree, or payload object.
Runtime/router bindings store only scalar IDs. Transport selects the required
targets and lifecycle bindings before assigning published sequence numbers.
Intermediate body chunks update scalar counters without emitting per-chunk rows.

The ordinary preservation case qualifies initial Hono and vanilla traffic using
native browser completion, actual SW receipt of head/end, page receipt,
registered-server selection, runtime/router binding, helper projection and the
real helper's successful request return. Missing coverage fails the existing
storage gate. Installation or HTTP success alone does not qualify it.
Native response and completion must belong to one page/request lifecycle. Page
receipt, dispatch and reply must share generation, router and reply-port identity;
helper evidence additionally shares the actual request and projected helper.
Mounted navigation may include an intermediate loading redirect. Native
qualification selects the single completed response with the guest head's actual
status, then joins its request and completion by page/request identity. The only
allowed extra lifecycle is one native SW 307 whose Location points into the
same-origin private loading route. Capture retains only that boolean marker.
Unexpected errors, network responses and duplicate responses still fail.

The per-browser preservation report includes the concise routing summary. The
progress report retains the bounded raw trace at failure and again after cleanup,
so delayed metadata survives even when the case times out or the page closes.
The final progress record can be more complete than the initial JSON report.

Failure summaries use native request URLs and unique target/port candidates
within the observed restart window. IDs remain realm-local. Repeated targets,
missing SW coverage, dropped rows and unknown transport tails cannot establish
a cross-realm join or a guest/filesystem cause. Metadata may arrive after the
primary error; final retention occurs after context cleanup without another
page evaluation. Observation adds work and does not promise timing neutrality.
