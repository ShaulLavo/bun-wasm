# SpiderMonkey host integration provenance

Classification: Original adapter.

Upstream path and revision: none. These host adapters and fixtures are original
bun-wasm code. They do not copy or modify Mozilla, Bun, Node, or WebKit code.

| Local paths | Purpose |
| --- | --- |
| `src/engine-kind.ts` | Explicit paired kinds, supported-only publication types, and strict core and side declarations. |
| `src/executable-paths.ts`, `src/bun-adapter.ts` | Opt-in package registration and immutable engine-qualified paths. |
| `web/build.ts`, `web/src/engine-loader.ts` | Optional paired staging and fingerprinted browser loading. |
| `web/src/runner.ts`, `web/src/subprocess-broker.ts` | Selected module reuse and child launchers. |
| `web/src/playground/app.tsx` | Display the explicitly selected experimental engine without changing the normal menu. |
| `web/scripts/node-host.ts`, `web/scripts/node-spawn.ts` | Explicit Node CLI loading and configured executable registration. |
| `web/src/memory-telemetry.ts` | No refresh calls for engines without a known telemetry record. |
| `scripts/spidermonkey-host-plumbing.test.ts`, `web/tests/fixtures/spidermonkey-tier-worker.ts`, `web/tests/fixtures/spidermonkey-node-host.ts` | Tiny paired initialization, loader rejection, staging, and concurrent child transport checks. |
| `tests/package/adapter.test.ts`, `tests/package/engine-kind.test.ts`, `tests/package/payload.test.ts`, `tests/package/fixtures/paired-asset-brand.ts` | Package registration, validation, and execution through Node and Bun package exports. |
| `web/tests/runner-process.test.ts`, `web/tests/tools-integrity.test.ts`, `scripts/no-hermes-publication.test.ts` | Browser runner and unchanged normal publication regressions. |
| `checks/quality-spidermonkey-host-plumbing.json` | One blocking quality owner for the focused source checks. |
| `docs/spidermonkey-host-plumbing.md` | Selection, child environment, telemetry, and acceptance boundaries. |

The tiny pair comes from the existing original parameterized generator
`tests/package/quickjs-plan-fixture.ts`. It is not a Mozilla library, production
guest, runtime acceptance artifact, or public107 packet input. The implementation
extends the reviewed no-Hermes shared-source contract without reopening its
publication or native admission scope.

The worker-review CLI preserves the normal QuickJS, JSC and Browser artifact
paths when `--wasm` is omitted. The empty option sentinel cannot resolve to the
current directory. Experimental SpiderMonkey selection still requires its
explicit pair and tier. The fixture source control covers omitted and explicit
paths independently.
