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
They add scalar observations around original calls, without changing request
payloads, ports, candidate ordering, receivers, return values, thrown errors,
or the original 3000 ms claim deadline. Page send-before-call and send-return
are separate events. SW reply records expose response status, chunk length and
completion, never header values, file contents or body bytes.

Original adapters are `scripts/storage-routing-build.ts`,
`scripts/storage-routing-collector.ts`, and
`scripts/storage-routing-evidence.ts`. The existing storage diagnostic build
flag enables them. Ordinary deployed builds omit them. Scalar SW batches use a
separate diagnostic message type; original preview messages remain unchanged.
The queue holds at most 256 rows; the host retains at most 4096 routing rows and
128 target request observations, independently of filesystem causal retention.
Every overflow is counted. No retained row contains a Request, MessagePort,
runtime, filesystem tree, or payload object.

The ordinary preservation case qualifies initial Hono and vanilla traffic using
native browser completion, actual SW receipt of head/end, page receipt,
registered-server selection, runtime/router binding, helper projection and the
real helper's successful request return. Missing coverage fails the existing
storage gate. Installation or HTTP success alone does not qualify it.

Failure summaries use native request URLs and unique target/port candidates
within the observed restart window. IDs remain realm-local. Repeated targets,
missing SW coverage, dropped rows and unknown transport tails cannot establish
a cross-realm join or a guest/filesystem cause. Metadata may arrive after the
primary error; final retention occurs after context cleanup without another
page evaluation. Observation adds work and does not promise timing neutrality.
