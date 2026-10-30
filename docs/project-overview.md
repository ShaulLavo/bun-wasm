# Project overview
<p align="center">Bun's Rust toolchain compiled to WebAssembly, with a Bun-compatible runtime: run JS apps, client and server, in a browser tab.</p>
<p align="center"><a href="https://github.com/ShaulLavo/bun-wasm/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/ShaulLavo/bun-wasm/actions/workflows/ci.yml/badge.svg"></a></p>

```console
user@bun:~$ bun test
(pass) fib > fib(20) = 6765
 5 pass
 0 fail
user@bun:~$ bun build index.ts --outfile out.js
Bundled 1 module in 41ms
user@bun:~$ bun run serve.ts
[preview] https://bun.sprockt.dev/playground/__preview/3000/ (Ctrl-C stops the server)
hello from Bun.serve
```

That is a terminal in a browser tab. The [playground](https://bun.sprockt.dev/playground/) ran every command in the tab, and the [React sandbox](https://bun.sprockt.dev/) bundles and hot-reloads an app the same way. Output is trimmed.

It is for people building in-browser development tools (playgrounds, tutorials, online editors, sandboxes) that need to run Bun and Node code without a server, and for anyone testing how far Bun's toolchain runs on WebAssembly. It is pre-1.0 and experimental, and many popular apps do not run yet (see [Status](#status)), so it does not replace Bun on your machine.

![The bun.wasm sandbox: a file tree and src/App.tsx on the left, a running React page with a counter on the right, and Bun's dev server output in the terminal below](assets/sandbox.png)

## Why

- **Bun's own toolchain.** The transpiler, bundler, resolver, semver and data parsers are Bun's own Rust crates, built for `wasm32-wasip1` from a pinned oven-sh/bun commit with [13 patches](bun-patches.md).
- **A Bun and Node runtime on three engines.** QuickJS and JavaScriptCore run inside the wasm, and a third guest runs on the page's own JS engine. One runtime, one test fixture suite for all three.
- **Server and client in one tab.** `Bun.serve`, `fetch` and `bun:sqlite` work. A service worker routes preview URLs to the guest's server.
- **Measured compatibility.** Bun's own test suite: 411 of 2,305 upstream files pass fully on QuickJS (17.8%). Real apps: 9 of 17 projects pass every stage (2026-10-17 snapshot). [Compatibility](compatibility.md) has the method and the failures.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture.dark.svg">
  <img alt="Layers of bun-wasm from top to bottom: your code, the bun.wasm guest containing Bun's Rust transpiler and bundler, the Bun-compatible runtime and a JavaScript engine, then the host interface of WASI, bun_wasm slots and runtime_proc, implemented by a browser host or a native Wasmtime launcher" src="assets/architecture.light.svg">
</picture>

The guest is one wasm module. The host, a browser tab or a native Wasmtime launcher, supplies files, network and processes.

## Quick start

Open the [playground](https://bun.sprockt.dev/playground/) and press **Run**. The guest loads in the tab, so there is nothing to install:

```console
user@bun:~$ bun run 'index.ts'
Hello, world.
Hello, Bun!
Hello, WebAssembly.
Bun version: 1.4.4
```

[Getting started](getting-started.md) walks through the terminal, a server and the sandbox, and shows how to run the playground on your machine.

## What you can do

- Try Bun in a tab: [Getting started](getting-started.md).
- Add Bun to your own page: [Embed bun-wasm in a page](guides/embed-in-a-page.md).
- Check whether your app runs: [Compatibility](compatibility.md).
- Find out what a tab cannot do: [Limits](limits.md).
- Fix a failure: [Troubleshooting](troubleshooting.md).
- Build the guests and run the tests: [Development](development.md).

## How it works

Bun's Rust crates and a runtime written in this repo make up the `bun` guest, `wasm32-wasip1`. The runtime implements `Bun.*`, `node:*` and the web APIs on a JavaScript engine behind an `Engine` trait. The host gives the guest files over WASI, sockets through function slots it installs before `_start`, and processes through `runtime_proc` imports. In a browser, each process is a Web Worker and all share one in-memory filesystem saved to IndexedDB. [Architecture](concepts/architecture.md) has the full picture, and the [decision records](adr/001-three-engines-behind-one-runtime.md) say why.

## Docs

[Getting started](getting-started.md) · [Guides](guides/embed-in-a-page.md) · [Concepts](concepts/architecture.md) · [Reference](README.md#look-up) · [Decision records](adr/001-three-engines-behind-one-runtime.md) · [All pages](README.md)

## Status

Pre-1.0 and experimental. The package is `bun-wasm` 0.0.61, marked private, and is not on npm. You install it as a Git dependency. The repository has no tags or releases.

- Memory: each guest is capped at 1 GiB.
- Threads: each guest is single-threaded. Workers are separate guests.
- Network: browsers get `fetch` (with CORS) and servers behind preview URLs. Raw outbound TCP, TLS sockets and Unix sockets do not work.
- No native addons. Nothing starts a native executable in the browser.
- The `browser` engine runs user code in the host glue's global scope. No engine is a security boundary.
- Apps: Vite, SvelteKit, Astro, Vitest, Next.js and Prisma fail at least one stage in the 2026-10-17 snapshot. Later fixes touched the Vite family, and a rerun is pending ([details](compatibility.md#real-apps)).

Platforms:

- Chromium, Firefox and WebKit (through Playwright) are covered by the CI browser gates.
- Safari and the iOS Simulator have manual scripts that CI does not run.
- The native launcher builds on Linux x86_64 in CI.

[Limits](limits.md) has the numbers and their sources.

## License and contributing

[MIT](../LICENSE). Upstream and third-party notices are in `crates/bunwasm-runtime/generated/builtins/LICENSE.md`. Read [Development](development.md) before you change code, and [AGENTS.md](../AGENTS.md) if you are an agent. The project takes no GitHub issues. Report security issues through [SECURITY.md](../SECURITY.md).
