# Bun upstream suite

The upstream suite measures bun-wasm compatibility on QuickJS, JSC, and the browser engine.

From the repository root with built guests and a launcher:

```sh
source env.sh
scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 \
  --output /work/tmp/bun-wasm-suite/quickjs.json js/node/path
```

- [Results, setup, reproduction, and scoreboard refresh](guide.md)
- [Failure index](failures.tsv) and [investigations](triage.md)
- [Runner/runtime failure grouping and path measurements](category-d-runtime.md)
