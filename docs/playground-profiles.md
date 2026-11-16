# Playground program profiles

Vite 8 React, Vite 8 vanilla, Angular and Nuxt on QuickJS, JSC and experimental
SpiderMonkey default to `shared-group`. Their compilers need shared Wasm memory
or shared buffers published to workers. The common template catalog declares
`sharedWorkers`, and `templateProfile(engine, template, requested?)` selects the
profile for the playground, sandbox and maintained goals. Browser, Vite 7
templates, Next.js, Hono and standalone examples keep the `split` default.

Nuxt 3.19.3 loads Oxc parser 0.94.0's wasm32-wasi binding, which constructs a
shared `WebAssembly.Memory`. The in-guest split adapter refuses that operation.
Browser uses the host WebAssembly implementation and keeps its split profile.
Selecting shared-group supplies the required capability; it does not establish
that every phase of Nuxt's workflow passes.

An explicit `?profile=split` or `?profile=shared-group` overrides the template
default before any guest loads. Browser rejects shared-group. The host verifies
the actual prepared core before registering Bun and its Node aliases. A mismatch
or missing profile pair fails startup without substituting another profile.

Partial `web/build.ts` builds may omit engines or shared programs. A full
`site/build.ts` build requires `SHARED_QUICKJS_PROGRAM` and
`SHARED_JSC_PROGRAM`, plus `SHARED_SPIDERMONKEY_PROGRAM` when SpiderMonkey is
included. Each points to a complete program directory produced by
`scripts/build-native-profile.ts shared-group OUTPUT ENGINE`. Staging verifies
the core, companion and original build records. Shared assets live under
`profiles/shared-group/`; the page loads only the selected engine/profile.

Goals runs without `--profile` use the same template defaults. Their source
metadata records `template-default`, and each startup records the actual engine
and profile. An explicit `--profile=split` remains a split diagnostic, including
for worker templates. Qualification still requires the ordinary lifecycle checks.
