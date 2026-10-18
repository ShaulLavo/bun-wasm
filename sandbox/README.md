# Browser sandbox

The sandbox edits React or vanilla TypeScript applications and runs Bun's dev server with hot reload in a worker.

Build the guest artifacts first, then run from the repository root:

```sh
cd sandbox
bun install --frozen-lockfile
bun run build
bun run preview
```

[Build setup, hot reload, dependency caching and verification](../docs/sandbox.md).
