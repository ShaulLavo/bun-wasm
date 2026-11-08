# Next playground build scheduling

Classification: Host feature, original application configuration and regression test.
No upstream implementation is copied or patched.

`sandbox/template-next/next.config.ts` configures Next.js 15.5.6 with its supported
`experimental.parallelServerBuildTraces` option. Next starts dependency tracing
after the server compiler finishes, while client compilation and page generation
continue. It still awaits tracing before completing the production build. The
single-CPU worker setting remains unchanged. Type checking, page generation,
trace output, and production startup stay enabled.

The upstream scheduling code is `next/dist/build/index.js` in the npm release
`next@15.5.6`. Without this option, that release starts server dependency tracing
after page generation. Interpreted engines spend most of this starter's build in
that analysis, so serial scheduling delays the browser playground unnecessarily.

`scripts/next-build-scheduling.test.ts` checks the complete starter configuration,
including the worker count and absence of settings that skip build work. Its
feature-owned quality manifest preserves blocking check discovery. The existing
goals runner exercises development, interaction, hot reload, production build,
and production startup with unchanged deadlines.
