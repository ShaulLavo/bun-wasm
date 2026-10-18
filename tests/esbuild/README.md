# esbuild package checks

These checks run the published `esbuild-wasm@0.25.12` package on the three engines and the playground.

After the build prerequisites and offline mirror are ready, run from the repository root through the host's heavy-job wrapper:

```sh
MATRIX_CACHE=/path/to/offline-mirror bun tests/esbuild/run.mjs
```

[Prerequisites, browser checks, fixtures and offline mirror setup](../../docs/esbuild-tests.md).
