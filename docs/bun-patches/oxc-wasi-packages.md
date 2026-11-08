# Oxc WASI package generation

Classification: original tooling and two adapted upstream generation steps.
Status: a development package recipe, not a consumer integration or publication.

## Source and generator ownership

All three original packages are version `0.94.0`:

- `@oxc-parser/binding-wasm32-wasi`, source `napi/parser`.
- `@oxc-transform/binding-wasm32-wasi`, source `napi/transform`.
- `@oxc-minify/binding-wasm32-wasi`, source `napi/minify`.

Their npm SLSA statements identify [Oxc commit f88f5f45](https://github.com/oxc-project/oxc/tree/f88f5f4593b56f77460beed2178ac7b207d5364c),
which has the tag `crates_v0.94.0`. There is no `v0.94.0` tag.
The statements are inspected over npm HTTPS and matched to pinned package
integrities. This is not independent signature or transparency-log verification.

That commit's `pnpm-workspace.yaml` and `pnpm-lock.yaml` pin NAPI-RS CLI 3.2.0.
The corresponding [generator source](https://github.com/napi-rs/napi-rs/tree/105dcede1c23989f103026e57469cb3c0d1991eb/cli)
is commit `105dcede1c23989f103026e57469cb3c0d1991eb`. Oxc and NAPI-RS use MIT licenses.
`inputs.lock.json` pins package tarball integrities, Wasm hashes, selected source
hashes, and the release export identifiers. No source or upstream lock is edited
in place. The separate recipe `bun.lock` freezes its own tooling dependencies.

## Adapted upstream generation steps

1. `emit.ts` adapts `cli/src/api/build.ts:Builder.writeWasiBinding`. The stock
   CLI reaches this private method only after Cargo and Rust type-definition
   generation. It has no public JavaScript-only build option. The adaptation
   invokes the exact pinned `createWasiBinding`, `createWasiBrowserBinding`,
   `WASI_WORKER_TEMPLATE`, and `createWasiBrowserWorkerBinding` source templates.
   It supplies the exact release export identifiers, not invented Rust build
   metadata. Default-policy CJS, browser, and both worker outputs must reproduce
   every original release byte before the maintained output can proceed.
2. `run.ts:bundleParser` adapts Oxc's
   `napi/parser/scripts/build-browser-bundle.js`. It retains the original
   `src-js/wasm.js` and `wrap.js`, entry alias, ESM format, and browser platform.
   Esbuild remains 0.25.10. Runtime 1.0.5 and its source-locked dependencies remain
   in this bundle. Stable logical dependency links with `preserveSymlinks` make
   build-path comments reproducible. The unmodified policy's bundle must equal
   the published bundle after minification removes those path comments. No
   delivery file is patched to achieve that comparison.

Packaging uses the normal CLI 3.2.0 `NapiCli.artifacts` collector, including its
browser worker URL conversion, followed by `npm pack --ignore-scripts`.
It does not call the collector's separate `createNpmDirs` command, which queries
npm's live runtime dist-tag. Package metadata instead retains the pristine
release's entry points, files, target restrictions, and dependency range.
The parser browser bundle is regenerated and included, never omitted or copied
with its old descriptor.

This is a maintained source-template emitter, not a claim that stock `napi build`
ran without Cargo. There is no loader text rewrite, constructor proxy, source
preparation hook, force-WASI flag, or package-selection change.

## Maintained identity and policy

The staged copies of all three authoritative addon manifests set
`napi.wasm.initialMemory: 1024` and `maximumMemory: 4096`. The original templates
keep `shared: true`. Each packed package keeps its original scoped name but uses
the distinct version `0.94.0-bun-wasm-memory.1` and includes
`bun-wasm-variant.json` with source, generator, policy, and Wasm identity.
These unpublished artifacts do not claim to be an unchanged upstream release.

A future integration can explicitly override each original binding package name
to its maintained tarball and integrity, leaving the ordinary outer loaders and
native-before-WASI selection order unchanged. That selection and its eventual
hosted pin require a separate decision. This PR changes no dependency pins,
versions, wrappers, Bun memory behavior, or Waffle code.

The exact original Wasm bytes remain unchanged. Their imported shared-memory
minima are 980, 981, and 981 pages; their module-declared maximum remains 65536.
A supplied 4096-page maximum links successfully but deliberately reduces future
capacity. It is not a claim about physical memory, reservation, or peak usage.

## Reproduce and check

Use Node 24 or newer with TypeScript stripping, Bun, npm, and tar. On this host,
source `env.sh` and use the local heavy runner. Use fresh owned directories:

```sh
source env.sh
scratch=$(mktemp -d /work/tmp/bun-wasm-oxc-packages-XXXXXX)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/deps"
cp scripts/oxc-wasi-packages/{package.json,bun.lock} "$scratch/deps/"
bun install --cwd "$scratch/deps" --frozen-lockfile
bun scripts/oxc-wasi-packages/run.ts "$scratch/work" "$scratch/deps"
bun scripts/oxc-wasi-packages/verify.ts "$scratch/work" "$scratch/deps" "$scratch/controls"
```

Preserve requested tarballs before teardown if another task needs them.
Downloads and source packages belong to the new work directory; original input
files remain unchanged. The verifier removes only the control directory it
successfully created and terminates all workers it observes.

The manifest-owned offline check is
`bun test scripts/oxc-wasi-packages/recipe.test.ts`. It covers policy identity,
fail-before descriptors, integrity failures, closure omissions, and cleanup
ownership. The explicit generation and verification commands additionally check
all packed files and unchanged Wasm hashes, then run six real Node NAPI controls,
one original and one maintained package per addon.

Parser and transform expose synchronous and asynchronous operations. Their
controls also cover concurrent jobs, actual NAPI worker memory handoffs, addon
error diagnostics, real allocator growth, stable prefix bytes, and refusal at
the maintained cap. Minify exposes no asynchronous API in this release; the
check does not fabricate one. Node controls use the existing published runtime
floor 1.0.6 with core/runtime 1.5.0 and wasi-threads 1.1.0, not today's runtime.

The runtime observer forwards real initializer calls and worker messages without
changing arguments. It exists only in the tests. A separate real worker exercises
Atomics wait, notify, memory aliasing, and growth; it is not credited as an Oxc
callback or addon thread API. Structured cap results report JS `RangeError` and
actual allocator return zero, not an invented addon out-of-memory exception.
These controls do not qualify browsers, Nuxt, Safari, unknown callbacks, or
production capacity. No Rust, Oxc, or Bun guest compilation is required.
