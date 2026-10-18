# Installer fixtures

A deterministic local registry tests package installation without forwarding requests to the public registry.

From the repository root with a built guest and launcher:

```sh
source env.sh
node tests/install/run.mjs
```

[Cases, native references, engine selection, and browser checks](../../docs/install-tests.md).
