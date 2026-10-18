# Installer fixtures

The installer checks use a local registry with deterministic packages and no upstream forwarding.

Build the guest and native launcher first, then run from the repository root through the host's heavy-job wrapper:

```sh
source env.sh
node tests/install/run.mjs
```

[Fixture coverage, engine selection, native controls and browser checks](../../docs/installer-tests.md).
