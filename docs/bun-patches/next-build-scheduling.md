# Next playground production traces

Classification: Host feature, original application configuration and test adapters.
No upstream implementation is copied or patched.

The Pages Router starter pins Next 15.5.6 and stable React 19.1.1 and builds with
webpack. Its `outputFileTracingExcludes` entry for `next-server` names only eight
compiled production runtime files for Turbopack or experimental React. The five
stable production runtimes remain eligible for tracing. No package, image
processor, application route, build phase, or production assertion is excluded.

The upstream selectors are
`next/dist/server/route-modules/{app-page,app-route,pages,pages-api}/module.compiled.js`.
Their webpack, production, stable-React branches select the retained runtime
files. `next/dist/lib/needs-experimental-react.js` checks the experimental React
configuration. `next/dist/build/collect-build-traces.js` applies the named
`next-server` exclusions before dependency analysis.

`scripts/next-trace-fixture.ts` checks those installed pinned selectors, reads the
generated trace manifests, requires the selected stable Pages runtime and rejects alternate runtime
leaks, and copies only trace-selected dependencies into an isolated project. It
moves the original dependency directory out of package resolution. The server
fixture exercises production SSR from that restricted project. Omitting a
required stable runtime is the negative control. Configuration and inventory
regressions have a feature-owned blocking quality manifest. Timing and live
correctness results are recorded by the lane, not inferred from these unit tests.

Policy eligibility is not reachability. The config-policy test keeps all five
stable variants eligible. The live Pages fixture does not require unused stable
App Route files to appear in the trace. Its SSR route requires the stable Pages
runtime, and restricted production execution tests the actual dependency closure.
