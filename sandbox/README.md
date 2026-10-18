# sandbox: Bun's dev server in your browser

The sandbox edits an in-memory React or vanilla TypeScript app and runs Bun's dev server in a worker.

```sh
cd sandbox
bun install
bun run build
bun run preview
```

Check hot reload against the preview:

```sh
node tests/hmr-check.mjs http://127.0.0.1:4173/
```

[Sandbox guide](../docs/sandbox.md) · [Browser runtime](../plans/browser-runtime.md)
