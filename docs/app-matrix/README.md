# App compatibility

The matrix measures installed applications on the three Bun WebAssembly engines and the browser playground.

After building the artifacts and preparing the offline mirror, run from the repository root through the host's heavy-job wrapper:

```sh
scripts/app-matrix.sh --apps=hono --engines=quickjs --hosts=native \
  --cache=/work/cache/bun-wasm-app-matrix --output=/work/tmp/bun-wasm-app-replay
```

[Build prerequisites, replay commands, results and investigations](guide.md).
