# Storage preview routing observation

Classification: adapted implementation and original diagnostic adapters.

The private build transforms in `scripts/storage-routing-build-source.ts` adapt
Waffle's `browser/service-worker.ts`, `browser/preview.ts`,
`browser/net/helper.ts`, and `browser/net/runtime.ts` from release `0.0.136`,
revision `022d711d78ffbe6c9c6a45fe1bcbd2d970d09ce7`.
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
