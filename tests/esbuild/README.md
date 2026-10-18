# esbuild package checks

These fixtures run the published esbuild-wasm package unchanged against the three guest engines.

From the repository root:

```sh
MATRIX_CACHE=/path/to/offline-mirror bun tests/esbuild/run.mjs
MATRIX_CACHE=/path/to/offline-mirror bun tests/esbuild/browser.mjs
```

[Guide and reference](../../docs/guides/esbuild-checks.md).
