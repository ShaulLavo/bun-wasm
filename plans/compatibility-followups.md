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

## Integration with the separate HTTP/WebSocket lane

`js/node/http/node-http-with-ws.test.ts` changes from 25 failures and a completed
file to 24 observed failures and a 15-second file timeout after real server
async disposal is available. The first error is `Unexpected server response:
200` from `ws/lib/websocket.js:913`; the file expects Node HTTP upgrade support.
HTTP upgrade/WebSocket work belongs to the parallel lane, so no protocol
implementation was added here. Preserve the new close/drain contract when
integrating that lane and rerun this exact file through `scripts/bun-suite.sh`
with the same loopback/dependency arguments above. See `before-extra.json` and
`final.json` in the retained report directory.

The other new timeout in the measured selection is
`js/node/child_process/child_process.test.ts`: it previously stopped during
collection because Bun.semver was missing. It now reaches 26 passes, 55 failures,
4 skips and 1 todo before the file deadline. Its first failure invokes the
unimplemented `ChildProcess.spawn` instance method at line 71. Existing
subprocess/IPC support is a separate follow-up; do not restore the collection
failure to hide it.
