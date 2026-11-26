# bun-wasm

Bun v1.4.5's Rust toolchain compiled to `wasm32-wasip1`, paired with a Bun-compatible runtime so `bun install`, `bun run`, `bun test`, `bun build` and `Bun.serve` run inside a browser tab with no server behind them.

## Try it

- [Sandbox](https://bun.sprockt.dev/) runs Next.js, Nuxt, SvelteKit, Astro, Vite and eight more starters in your tab. Pick one, install it and edit live.
- [Playground](https://bun.sprockt.dev/playground/) opens an editor, a terminal and one-click Bun API demos with a live server preview. Press Run.

```console
user@bun:~$ bun -e 'console.log(2 ** 10)'
1024
user@bun:~$ bun run 'index.ts'
Hello, world.
Hello, Bun!
Hello, WebAssembly.
```

In the 2026-11-23 [compatibility matrix](docs/compatibility.md) on Bun 1.4.4 guests, all 13 frameworks install, start, update on edit and build across Chrome, Firefox, desktop Safari and iPhone Safari in the iOS simulator, on four JavaScript engines.

## Embed it

bun-wasm registers `bun`, `node` and `nodejs` on a [Waffle](https://github.com/ShaulLavo/waffle) runtime that your page owns, downloading the verified default browser guest on first spawn. See [Embed bun-wasm in a page](docs/guides/embed-in-a-page.md).

## Links

- [Project overview](docs/project-overview.md) covers architecture, engines, performance and status.
- [Getting started](docs/getting-started.md)
- [All documentation](docs/README.md)
- [Development](docs/development.md)
- [MIT license](LICENSE)
