# bun-wasm

Bun v1.4.5's Rust toolchain compiled to `wasm32-wasip1`, with a Bun-compatible runtime around it, so `bun install`, `bun run`, `bun test`, `bun build` and `Bun.serve` run inside a browser tab with no server behind them.

## Try it

- [Sandbox](https://bun.sprockt.dev/): pick a framework (Next.js, Nuxt, SvelteKit, Astro, Vite and more), install it, run its dev server and edit it live.
- [Playground](https://bun.sprockt.dev/playground/): an editor and a terminal. Press **Run**.

```console
user@bun:~$ bun -e 'console.log(2 ** 10)'
1024
user@bun:~$ bun run 'index.ts'
Hello, world.
Hello, Bun!
Hello, WebAssembly.
```

All 13 frameworks in the test matrix start, render, hot-reload and build on Chrome, Firefox, desktop Safari and iPhone Safari, on four JavaScript engines ([Compatibility](docs/compatibility.md)).

## Embed it

bun-wasm registers `bun` and `node` on a [Waffle](https://github.com/ShaulLavo/waffle) runtime that your page owns. [Embed bun-wasm in a page](docs/guides/embed-in-a-page.md) has the setup.

## Links

- [Project overview](docs/project-overview.md): architecture, status, performance
- [Getting started](docs/getting-started.md)
- [All documentation](docs/README.md)
- [Development](docs/development.md)
- [MIT license](LICENSE)
