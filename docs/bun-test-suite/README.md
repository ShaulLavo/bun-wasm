# Bun upstream compatibility

This directory records compatibility measurements against Bun's unchanged upstream tests.

From the repository root:

```sh
source env.sh
scripts/bun-suite.sh --network loopback --jobs 2 --timeout 15 js/bun/http
```

[Guide and reference](results.md).
