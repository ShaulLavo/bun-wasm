# Supplemental suite dependencies

This directory pins the packages used by Bun's upstream suite.

Run from the repository root:

```sh
source env.sh
BUN_INSTALL_CACHE_DIR=/work/cache/bun bun install \
  --cwd docs/bun-test-suite/dependencies --ignore-scripts --linker hoisted --frozen-lockfile
```

[Version sources, fixture limits and replay commands](setup.md).
