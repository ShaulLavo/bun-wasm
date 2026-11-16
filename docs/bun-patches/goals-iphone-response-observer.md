# iPhone preview response observation

Classification: Host feature, original test adapter. No upstream implementation is copied.

The visible iPhone service-worker observer records only the configured preview's
request ID, URL and nonce, response status and selected text headers, observer-fetch
result, body-read completion or failure, and the transform's final operation.
Its bounded collector stores text, numbers, booleans and nulls. It stores no response,
port, byte buffer, page content or owner-tab data. Response and observer bytes keep
their existing transformation path. Existing document replacement, nonce,
time-origin and trusted-input checks remain the authority for phase results.

The collector owns `scripts/goals-matrix/iphone-responses.ts`; its caller is the
visible iPhone controller in `iphone-bus.ts` and `iphone-server.ts`. The serialized
service-worker adapter is `scripts/goals-matrix/iphone-service-worker.ts`.
