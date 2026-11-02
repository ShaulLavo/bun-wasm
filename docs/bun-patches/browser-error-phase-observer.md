# Browser error-phase observer adapters

Class **Host feature**. These files implement an opt-in internal diagnostic. They do not change Bun, the guest, a production host, or the normal Next app fixture.

## Copied upstream descriptor fixture

`scripts/app-matrix/fixtures/browser-error-phase-observer/load-components-descriptor.ts` retains the exact export prelude of Next.js `v16.4.3`, `dist/server/load-components.js`, generated from `packages/next/src/server/load-components.ts`. Upstream is Vercel Next.js, MIT licensed, copyright Vercel, Inc. The retained complete source SHA-256 is `47e1446da77172ba77d6f3e6f68ae00ca7bebda206b26c0ba8625d41915dcaed`. The TypeScript wrapper stores its unchanged prelude as a string and the test pins the prelude digest. No installed Next graph is imported.

The only local adaptation is the TypeScript string wrapper. It allows the test to verify that the nonconfigurable getter export remains unchanged when method replacement refuses it. The runtime observer does not modify this export.

## Original adapters

- `next-acceptance-observer.ts` stages the dedicated instrumentation files, adds the Pages SSR positive control, preserves `node:http` as an external module, and adds the serving-worker acknowledgement to the diagnostic context response. Exact source markers must match before adaptation. It records all staged diagnostic source hashes.
- `fixtures/browser-error-phase-observer/instrumentation.ts` registers only in the Node serving runtime.
- `server-observer-call.ts` observes calls through proxies and side reactions while returning the original result. Data-property descriptors are preserved. Accessors and immutable function properties are refused. Inherited HTTP methods are shadowed on their own prototypes. Promise-brand and settlement inspection is best-effort and cannot replace a returned proxy or the original error.
- `server-observer-runtime.ts` obtains the cache only through public `module.createRequire`. It wraps nine class methods on cached BaseServer, NextNodeServer, and DevServer prototypes. It associates HTTP request objects with async context, assigns call IDs, and observes HTTP writer and finish events. Missing class or HTTP methods fail hook qualification. No exported Next functions are replaced. Argument correlation reads only own data descriptors, never accessor values. Detail fields retain only string and boolean values, so logging cannot invoke an argument value's serialization hooks. Inaccessible metadata is omitted; coverage must still qualify independently.
- `server-observer-state.ts` shares registration state within the serving worker and caps retained records at 4096.
- `next-acceptance-observer-control.ts` sends and checks the six actual requests, requires the serving acknowledgement, and verifies terminal coverage before invalid edits. Source fixtures test this ordering without app execution.
- `next-acceptance-phase-coverage.ts` is the corrected route-aware verifier. Handler-owned responses do not require the class sender. The Pages fixture does. Lookup intervals remain coarse, not direct `loadComponents` timings.

These original adapters adapt retained diagnostic references onto the selected corrected source. They do not inherit the historical driver's engine selection, artifact identity, replay admission, or results. See [diagnostic behavior and prerequisites](../browser-error-phase-observer.md).
