# Oxc WASI package generation

Classification: original tooling with an adapted source-only NAPI-RS emitter.
Status: development only. No dependency selection, consumer pin, or publication changes.

The recipe under `scripts/oxc-wasi-packages/` targets parser, transform, and minify
0.94.0. It sets each source addon's `napi.wasm.initialMemory` to 1024 and
`maximumMemory` to 4096. Shared memory remains enabled by the generator.

The npm provenance statements identify Oxc commit
`f88f5f4593b56f77460beed2178ac7b207d5364c`, tagged `crates_v0.94.0`.
The tag `v0.94.0` does not exist. Source manifests are `napi/parser/package.json`,
`napi/transform/package.json`, and `napi/minify/package.json`. The source
`pnpm-lock.yaml` and catalog pin NAPI-RS CLI 3.2.0, not today's CLI.

The stock CLI does not expose a source-only package command.
`cli/src/api/build.ts:Builder.writeWasiBinding` is its smallest complete loader
emitter, reached only after Cargo and type-definition generation. The maintained
adapter must be reviewed as a source change; direct template invocation is not a
claim that the stock `napi build` command ran. The adapter uses the exact release
export identifiers and pinned upstream templates, and checks default-policy output
against pristine published loader and worker bytes before changing any policy.

Packed outputs must carry a distinct maintained prerelease identity and retain
unchanged Wasm bytes. The parser's browser bundle is part of its package closure,
not an optional file. Real addon controls do not establish framework, browser,
or Safari acceptance. Further provenance, commands, and measured limits follow
with the runnable recipe.
