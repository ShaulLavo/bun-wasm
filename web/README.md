# Browser playground

The playground runs `bun.wasm` with a terminal, editor and shared filesystem in the browser.

Build the guest artifacts first, then run from the repository root:

```sh
cd web
bun install --frozen-lockfile
bun run build
bun run preview
```

[Builds, engines, networking, terminal and browser verification](../docs/browser-host.md).
