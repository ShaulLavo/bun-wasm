# Supplemental suite dependencies

This directory pins packages imported by Bun's upstream tests. The suite runner copies
the installed tree into each private snapshot at `test/node_modules`. It does not
install packages or contact a registry during a test.

```sh
source env.sh
BUN_INSTALL_CACHE_DIR=/work/cache/bun bun install \
  --cwd docs/bun-test-suite/dependencies --ignore-scripts --linker hoisted --frozen-lockfile
```

Versions follow `test/package.json` at Bun revision
`5e0baa66516f3af00b008cdf1521c681317741e8`, except these packages:

| Package | Version source |
| --- | --- |
| `react`, `react-dom` | Bun's root manifest pins `18.3.1`. |
| `bun-plugin-svelte` | The published `0.0.6` package matches the upstream package version. The local workspace entry also requires Bun's development workspaces. |
| `abort-controller` | Bun's test lock pins `3.0.0`. |
| `node-fetch`, `isomorphic-fetch`, `@vercel/fetch` | Explicit `2.7.0`, `3.0.0`, and `6.2.0` pins for imports missing from the upstream manifest. `node-fetch` 2 supports the suite's CommonJS import. |
| `utf-8-validate` | Explicit `6.0.5` pin for the first-party compatibility test. |
| `graphql` | Explicit `16.10.0` peer dependency for `type-graphql`. |
| `@testing-library/dom` | Bun's test lock pins the React testing peer to `10.4.0`. |
| `rollup` | The official `@rollup/wasm-node` distribution at the upstream `4.4.1` version, installed under the `rollup` name. The unchanged suite imports `rollup/parseAst`. Astro's nested `vite/rollup` resolution uses the same distribution at its already-locked `4.64.9` version. |

Install scripts remain disabled, including native addon compilation and binary downloads.
Installing a package does not make its native bindings available to the guest.
The [dependency replay](../dependency-replay.md) records the first failures
after provisioning, including native addon and external-service requirements.

`bake/*` is a suite source alias, not an npm package. The runner maps the two imported
Bake helpers to their files under `src/runtime/bake/client/`, beside its existing
harness aliases. Package entry points keep relative imports in that upstream directory.
`data:text`,
`_http_agent`, and the generated `test-package` fixture are runtime resolution tests.
Installing similarly named npm packages would not test their intended behavior.

## Fixture and native binding limits

These assignments apply to the isolated, fixture-only replay. They record the first
blocker after package installation.

| Fixture | Remaining prerequisite |
| --- | --- |
| Canvas and Prisma | The canvas import cannot load its native binding. Its fallback package, `@napi-rs/canvas-wasm32-wasi@0.1.91`, returns 404 from the registry. The Prisma file stops on that import before it tests Prisma. |
| Resvg | The `@resvg/resvg-js@2.4.1` binding loader rejects the guest's `wasm32` architecture. |
| Sharp | Its loader searches `.node` addons, including the optional wasm32 build. The guest has no Node-API addon loader, and the replay cannot load a binding for its wasm32 runtime. |
| MySQL integration | The upstream harness requires an external `docker` executable and a running container. |
| Azure Service Bus, MongoDB, PostgreSQL and Stripe | The upstream harness requires live-service secrets. External account fixtures are excluded from this replay. |
| Frontend inspector | The upstream inspector transport listens on a Unix-domain socket, which the current host ABI does not provide. |

To replay the fixed selection on all three built engines, run this through the host's
heavy-job wrapper:

```sh
bun scripts/measure-suite-dependencies.ts \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-dependency-results
```

The command uses loopback-only networking, one worker, a 15-second file deadline,
and the runner's 2,000 ms test deadline. The runner removes private snapshots and
test process groups. The caller owns the results directory and its logs.
