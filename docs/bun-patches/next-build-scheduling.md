# Next playground production traces

Classification: Host feature, original application configuration and test adapters.
No upstream implementation is copied or patched.

The Pages Router starter pins Next 15.5.6 and stable React 19.1.1 and builds with
webpack. Its `outputFileTracingExcludes` entry for `next-server` names only eight
compiled production runtime files for Turbopack or experimental React. The five
stable production runtimes remain eligible for tracing. No package, image
processor, application route, build phase, or production assertion is excluded.

The starter also sets `experimental.webpackBuildWorker: false`. Next 15.5.6's
`dist/build/index.js` otherwise enables the compiler worker when the application
has no custom webpack configuration. `dist/build/webpack-build/index.js` creates
and ends one separate compiler process for each server, edge and client pass.
The setting runs those passes in the existing build process. It keeps the
one-CPU policy, TypeScript verification, static generation, dependency tracing
and production output checks. No upstream source is modified.

Matched Linux WebKit diagnostics on the original post-J11 host and guests
sampled 5.88% lower build PSS on QuickJS and 21.84% lower PSS on SpiderMonkey,
and both modified workflows passed all nine phases. These are sampled process
tree readings, not native Safari qualification or proof of an initiating OOM.
The separate `webpackMemoryOptimizations` option reduced the QuickJS sample by
only 0.14% and was not selected.

The upstream selectors are
`next/dist/server/route-modules/{app-page,app-route,pages,pages-api}/module.compiled.js`.
Their webpack, production, stable-React branches select the retained runtime
files. `next/dist/lib/needs-experimental-react.js` checks the experimental React
configuration. `next/dist/build/collect-build-traces.js` applies the named
`next-server` exclusions before dependency analysis.

`scripts/next-trace-fixture.ts` checks those installed pinned selectors, reads the
generated trace manifests, requires the selected stable Pages runtime and rejects alternate runtime
leaks, and copies only trace-selected dependencies into an isolated project.
Staging requires an absent or empty destination and rejects leftover files without
deleting them, so a failed copy cannot contaminate a later restricted run. It moves the original dependency directory out of package resolution. The server
fixture exercises production SSR from that restricted project. Omitting a
required stable runtime is the negative control. Configuration and inventory
regressions have a feature-owned blocking quality manifest. Timing and live
correctness results are recorded by the lane, not inferred from these unit tests.

Policy eligibility is not reachability. The config-policy test keeps all five
stable variants eligible. The live Pages fixture does not require unused stable
App Route files to appear in the trace. Its SSR route requires the stable Pages
runtime, and restricted production execution tests the actual dependency closure.

Campaign limits catch hangs: ordinary phases have 300,000 ms and install/build
have 600,000 ms. Cleanup retains its existing 20,000 ms bound and shorter inner
cleanup limits. Serialized evidence records the actual limits and durations.

The goals terminal reader joins xterm soft-wrapped rows using `isWrapped` and
preserves real newlines. Its failing-first regression covers the missing-runtime
diagnostic that a physical row boundary previously split. These runner changes
and fixture utilities are original host adapters, not upstream patches. Knip lists
the restricted server as a guest fixture entry; its project-local module loader
resolves Next from the staged application, not the host tool's dependencies.
