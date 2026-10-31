# web: Bun in your browser

A static playground with a terminal, editor, and `bun.wasm` running in a worker.

```sh
cd web
bun install
bun run build
bun run preview
```

Use a different guest build:

```sh
BUN_WASM=/path/to/x.wasm bun run build
```

[Playground guide](../docs/playground.md) · [Browser engine](../docs/engine-browser.md)
