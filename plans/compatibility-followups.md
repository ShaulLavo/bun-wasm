# Compatibility follow-ups

Status: Approved

## YAML stress tests can exhaust the WASM engine stack

The unchanged main artifact and the compatibility branch both exit 134 while
running `js/bun/yaml/yaml.test.ts` with the upstream runner. Before the snapshot
matchers the file reports 588 passes and 673 failures; after them it reports
1,261 passes and no assertion failures, then traps before the final report.
Neither run is a fully passing file. Both use a 15-second file limit and a
2-second test limit, and both trap rather than time out.

Reproduce after installing the pinned supplemental dependencies:

```sh
source env.sh
scripts/bun-suite.sh --network loopback --jobs 1 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-yaml-stack-control.json js/bun/yaml/yaml.test.ts
```

Evidence is retained in `/work/reports/bun-wasm-compat-next-2026-10-15/`:
`before.json` and `snapshots-after.json`. The latter contains
`wasm trap: call stack exhausted`, with `JS_ArraySpeciesCreate`,
`js_array_every` and repeated `JS_CallInternal` frames. Snapshot comparison
failures and the runner deadline are ruled out as the cause: the original
artifact also traps, and the fixed snapshot comparisons all pass.

Investigate the two million-node stringify stress cases at
`vendor/bun/test/js/bun/yaml/yaml.test.ts:4310` and `:4323`, then the recursive
`aliases.visit` and `yamlStringify` paths in
`crates/bunwasm-runtime/src/js/formats.js`. These are candidates, not a confirmed
stack trace mapping. Keep the upstream tests unchanged and make excessive depth
throw a catchable error before reaching the engine's WASM call-stack limit.
Verify the exact file on QuickJS, JSC and browser, plus the existing format
fixtures. No suite timeout increase is needed.
