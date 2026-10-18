# Bun sandbox

The sandbox edits React or vanilla TypeScript apps and runs Bun's HTML bundler with hot reload in a browser worker.

From the repository root:

```sh
bun install --cwd sandbox --frozen-lockfile
(cd sandbox && bun run build)
ROOT=sandbox/dist PORT=0 bun web/serve.ts
```

[Guide and reference](../docs/guides/sandbox.md).
