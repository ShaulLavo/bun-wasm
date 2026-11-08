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

The measured default campaign bound is 90,000 ms. Next's build alone has a
110,000 ms bound, about 14% above the slower measured Chrome build of 96,483 ms.
All other campaign phases and frameworks keep 90,000 ms. Cleanup retains its
existing 20,000 ms bound and shorter inner cleanup limits. An explicit larger
diagnostic campaign bound still applies. Serialized deadline evidence records
both install and build bounds and rejects missing or different build policy.
This is a measured budget correction alongside narrow trace pruning, not a claim
that the engines became faster.

The goals terminal reader joins xterm soft-wrapped rows using `isWrapped` and
preserves real newlines. Its failing-first regression covers the missing-runtime
diagnostic that a physical row boundary previously split. These runner changes
and fixture utilities are original host adapters, not upstream patches. Knip lists
the restricted server as a guest fixture entry; its project-local module loader
resolves Next from the staged application, not the host tool's dependencies.
