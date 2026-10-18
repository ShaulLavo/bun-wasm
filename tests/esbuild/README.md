# esbuild package checks

These checks run the published esbuild-wasm package against all three guest engines.

From the repository root with built guests and an offline mirror:

```sh
source env.sh
MATRIX_CACHE=/path/to/offline-mirror bun tests/esbuild/run.mjs
```

[Setup, fixtures, browser checks, and retained mirror records](../../docs/esbuild-tests.md).
