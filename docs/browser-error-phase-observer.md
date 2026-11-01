# Browser error-phase diagnostics

This is an internal, opt-in diagnostic host change, not normal fixture behavior or application acceptance. Source-only controls do not qualify a producer packet, a Browser run, or phase timings.

## Authorize the run separately

Before an actual run, obtain independent source review and execution authorization for the changed diagnostic host. Recheck the actual installed Next 16.4.3 methods against the route profiles. Supply the byte-admitted normal guest and its unchanged receipt. Historical private diagnostics and producer qualification do not qualify this host.

Use `--phase-observation` only with `--engine browser --phases install,dev --cycles 0`, a runtime receipt, and complete pinned registry replay. Follow the [original-index identity rules](next-acceptance.md). Missing inventory or a scanner refusal stops the run. Do not upload, repackage, recover around the refusal, warm routes through another path, or fall back to another runtime or registry.

## Read the control gate

The runner stages the observer and `pages/phase-sender-control.tsx` before any compilation. It preserves the ordinary fixture on disk. The actual request page navigates to the intended HTTP origin before process or observer requests. A separate readiness page cannot admit it.

Before any invalid edit, the runner identifies the serving process and sends these six requests with the existing `x-bun-writer-probe` header:

| Tag | Route | Expected response |
| --- | --- | --- |
| `phase-handler-context` | `/api/context` | 200, serving-worker acknowledgement and matching header and cookie context |
| `phase-normal-dynamic` | `/dynamic` | 200, `server-original` and matching context |
| `phase-normal-missing` | `/missing-acceptance` | 404, `NEXT-01 missing` |
| `phase-class-sender` | `/phase-sender-control` | 200, `NEXT phase class sender` |
| `phase-overlap-a` | `/dynamic` | 200, `server-original` and matching context |
| `phase-overlap-b` | `/dynamic` | 200, `server-original` and matching context |

Each response must reach EOF with bytes. The acknowledgement must identify the same serving process, the public `module.createRequire` cache provider, the three expected cached Next classes, and every installed class and HTTP hook. The last two requests run concurrently. Their cookies are removed after both settle, including failures.

The runner then reads the serving terminal and calls `verifyPhaseObservationControls`. All six tags need distinct request-object identities. Required class calls need same-call entry, return, and resolve records. HTTP writer and finish records must show the expected status. The missing route needs compilation coverage. The Pages control needs the class sender. App handlers may complete their HTTP response without that sender, but any observed sender must have a complete interval. The same-URL requests must actually overlap.

Only completed response checks plus verified terminal records produce `phase-coverage-qualified.json`. Synthetic unit-test records never supply an actual run's controls. Failed admission, process identification, acknowledgement, responses, or phase coverage stops before the invalid edit. There is no broad route warmup. Compile recovery retains the existing deadline and restoration logic. Diagnostic page headers tag recovery requests as `compile-error` and `application-error`; multiple polls retain separate request IDs under the shared recovery tag. Those error records are not reinterpreted as the six successful controls.

## Interpret the output

`run.json` records diagnostic source hashes and always reports full acceptance as false in observer mode. `phase-control-responses.json` retains completed responses, and `phase-control.log` retains the observed terminal. Normal cleanup retains the final terminal even after a control failure.

The observer refuses accessor exports instead of mutating them. It never wraps `loadComponents` or `send-payload`. Component lookup spans are coarse surrounding calls, not direct component-loading times. The descriptor fixture tests the unchanged upstream export prelude without importing Next.

The observer adds allocations, logging, promise reactions, and async-context work. Its side reactions mark original promises handled. Methods become proxies. Source controls preserve receivers, arguments, synchronous throws, original promise identity, and thenable getter behavior. They do not establish zero perturbation or uninstrumented timing equivalence.
