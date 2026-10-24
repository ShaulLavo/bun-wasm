# Development

How to build bun-wasm from source, run its tests, and change it. To use bun-wasm without building it, read [Getting started](getting-started.md).

## What you need

The native build runs on Linux x86_64. The CI job "Rust workspace tests (QuickJS host)" is the reference setup, and `.github/workflows/ci.yml` has its exact steps. The playground build and preview also run on macOS.

| Tool | Version | Used for |
| --- | --- | --- |
| Rust | nightly `nightly-2026-09-15`, pinned in `rust-toolchain.toml`, with the `wasm32-wasip1` target | Every crate |
| WASI SDK | 34.0 | C and C++ parts: QuickJS, SQLite, BoringSSL, JavaScriptCore |
| Bun | 1.4.4 | Build scripts, tests, the web apps |
| Node.js | 24 or later | Runtime TypeScript transpile step, host scripts |
| cmake, ninja, nasm, clang, libclang-dev, pkg-config, ruby, gperf, bison | Current distro packages | Native dependency builds |
| Binaryen | 133 | `wasm-opt`. The JSC guest requires it. The other builds use it when present. |

`env.sh` sets the toolchain environment, and every build script sources it. Its defaults point at a workstation layout under `/work/cache`. Override `RUSTUP_HOME`, `CARGO_HOME`, `WASM_TOOLS`, `WASI_SDK_PATH`, `BUN_WASM_SYSROOT` and `CARGO_TARGET_DIR` before sourcing it to use your own paths. Large builds need several GB of RAM, so lower `-j` on a small machine.

## Build the guests and the launcher

Run each command from the repository root.

```sh
source env.sh
scripts/sync-bun.sh                          # clone oven-sh/bun at the pinned commit and apply patches/bun
scripts/build.sh                             # dist/bun.wasm, the QuickJS guest
scripts/build-bun-browser.sh                 # dist/bun-browser.wasm, the host-engine guest
scripts/build-jsc.sh && scripts/build-bun-jsc.sh   # dist/bun-jsc.wasm, JavaScriptCore (about 10 minutes at -j6 on the maintainer's machine)
scripts/build-bun-tools.sh                   # dist/bun-tools.wasm, lint and fmt
cargo build -j 4 --release -p bunwasm-host   # the native launcher, $CARGO_TARGET_DIR/release/bun-wasm
```

You do not need all of them. `dist/bun.wasm` plus the launcher runs programs from a terminal. The playground needs the guests you want in its engine picker. Every build writes a `.build.json` receipt next to the artifact ([Guest build receipts](guest-build-receipts.md)).

Run a program with the launcher. Use it, not plain `wasmtime run`, because it supplies the `runtime_proc` imports:

```sh
printf 'console.log("hello from bun-wasm");\n' > index.ts
"$CARGO_TARGET_DIR/release/bun-wasm" --wasm "$PWD/dist/bun.wasm" \
	--dir "$PWD::/" --env PWD=/ -- run /index.ts
```

`bun-wasm --launcher-help` lists the launcher options.

## Run the tests

| Command | What it checks |
| --- | --- |
| `scripts/test.sh [--engine quickjs\|jsc\|browser] [name...]` | The end-to-end fixtures in `tests/fixtures/`. Each runs a program and diffs its output against what native Bun 1.4.2 printed. |
| `scripts/test-web.sh` | The playground: type check, unit tests, network fixtures, then Chromium and WebKit ([Browser gate coverage](browser-gates.md)). |
| `bun run quality` | Lint, types, unused code, duplicates and Rust checks ([Code quality](code-quality.md)). |
| `bun run check && bun test ./tests/package/*.test.ts` | The `bun-wasm` package. |
| `bun scripts/refresh-compatibility-docs.ts --check` | The generated tables in the compatibility records. |

`scripts/test.sh --update` regenerates a fixture's `expected.txt` with native Bun. Review the diff before you commit it. To add a fixture, create `tests/fixtures/<name>/` with an `index.ts` and an `expected.txt`. The header of `scripts/test.sh` documents the optional files.

## Change Bun's source

`vendor/bun` is git-ignored and `scripts/sync-bun.sh` re-creates it. Make changes there as commits on the `wasm` branch, never as loose edits, because the sync script refuses a checkout with local changes.

1. Commit the change on the `wasm` branch inside `vendor/bun`. Keep it small: add `target_os = "wasi"` arms and host hooks.
2. Run `scripts/export-patches.sh` to rewrite `patches/bun/*.patch`.
3. Add a classified row and a section to [`docs/bun-patches.md`](bun-patches.md) in the same change. Record the upstream path and revision, what changed, and why.

[ADR 005](adr/005-patch-bun-minimally-and-keep-a-ledger.md) explains the policy.

## Write runtime code

- Write new code in TypeScript. Do not hand-write JavaScript or commit compiled JavaScript unless a build step forces it.
- Use Rust for native work: filesystem, sockets, crypto, compression, parsing.
- Prefer Bun's own `src/js` modules through the builtin loader over writing new ones ([Bun JavaScript builtins](bun-builtins.md)).
- Write new runtime factories in `crates/bunwasm-runtime/src/js/*.ts` ([Runtime TypeScript](runtime-typescript.md)).

## Where to read next

| To change | Read |
| --- | --- |
| The browser engine or module loading | [The browser engine](engine-browser.md) |
| Network or process functions | [Host ABI](host-abi.md) |
| JavaScriptCore | [JavaScriptCore for wasm32-wasip1](jsc-build.md), [A portable backend for Bun's Rust host functions](bun-jsc-backend.md) |
| The installer | [Installing npm packages](install.md), [Installer fixtures](install-fixtures.md) |
| Publishing a guest | [Guest artifact publishing](guest-publishing.md) |
| Stack behavior | [Stack overflow in wasm](stack-limits.md) |
| How it all fits | [Architecture](concepts/architecture.md) |

The repository takes no GitHub issues. [Agent instructions](../AGENTS.md) hold the conventions agents follow.
