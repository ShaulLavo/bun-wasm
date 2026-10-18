# Bun's upstream suite

The suite runner measures Bun's upstream tests on the three WebAssembly engines in isolated snapshots.

After building the artifacts and installing the pinned dependencies, run from the repository root through the host's heavy-job wrapper:

```sh
scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-suite-results/quickjs.json
```

- [Build prerequisites, full census, commands and result definitions](guide.md)
- [Dependency provisioning replay](dependency-replay.md)
- [Dependency installation and version sources](dependencies/setup.md)
- [Current failure assignments](failures.tsv) and [failure groups](triage.md)
