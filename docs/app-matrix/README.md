# App compatibility matrix

The app matrix measures real frameworks across bun-wasm engines and browser hosts.

From the repository root:

```sh
source env.sh
scripts/app-matrix.sh --apps=next --engines=browser --hosts=native \
  --cache=/work/cache/bun-wasm-app-matrix --timeout=90 \
  --output=/work/tmp/bun-wasm-app-matrix
```

[Results, offline registry setup, reproduction, and investigations](guide.md).
