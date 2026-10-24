# bun-wasm

Bun compiled to WebAssembly: one `wasm32-wasip1` guest that runs `bun run`, `bun test`, `bun build`, `bun install` and `Bun.serve` in a browser worker or under the native Wasmtime launcher. Read `docs/concepts/architecture.md` before changing crate boundaries or the host interface.

## Environment

- Run `source env.sh` before any build or test. Its defaults point at toolchains under `/work`. Set `RUSTUP_HOME`, `CARGO_HOME`, `WASM_TOOLS`, `WASI_SDK_PATH`, `BUN_WASM_SYSROOT` or `CARGO_TARGET_DIR` first to use other paths.
- Builds are heavy. The workstation has about 9 GB of free RAM: use `cargo build -j 12` or fewer.
- Keep scratch in `/work/tmp/bun-wasm-*` and clean it up.
- Node.js 24 or later runs TypeScript on the host by stripping types. It does not downlevel code.

## Commands

- Build guests: `scripts/sync-bun.sh`, then `scripts/build.sh` (`dist/bun.wasm`), `scripts/build-bun-browser.sh`, `scripts/build-jsc.sh` then `scripts/build-bun-jsc.sh`, `scripts/build-bun-tools.sh`. Build the launcher with `cargo build -j 4 --release -p bunwasm-host`.
- Run a guest with the launcher (`$CARGO_TARGET_DIR/release/bun-wasm --wasm dist/bun.wasm ...`). Plain `wasmtime run` fails because the guest imports `runtime_proc`.
- Fixtures: `scripts/test.sh [--engine quickjs|jsc|browser] [name...]`. A runtime change must pass on all three engines.
- Browser host: `scripts/test-web.sh`. Package: `bun run check && bun test ./tests/package/*.test.ts`. Lint, types, Rust: `bun run quality`.
- `docs/development.md` has the full setup.

## Rules

- Write new code in TypeScript. Do not hand-write JavaScript or check in compiled JavaScript unless a build step forces it (owner, 2026-10-16).
- Use Rust for native work: fs, sockets, crypto, compression, parsing. Prefer Bun's own `src/js` modules through the builtin loader over writing new ones.
- Keep engine-specific behavior behind the `Engine` trait (`crates/bunwasm-runtime/src/engine.rs`).
- Every new or changed upstream patch, copied file, or adapted implementation gets a classified row and a section in `docs/bun-patches.md` in the same PR. This covers Bun, Node, WebKit and other upstreams, including source outside vendor directories. Record the upstream path and revision, the local changes, and the reasons. List original adapters separately.
- Patch Bun in `vendor/bun` on branch `wasm` as commits, then run `scripts/export-patches.sh`. `vendor/bun` is git-ignored and `scripts/sync-bun.sh` re-creates it. Keep patches minimal: add `target_os = "wasi"` arms, do not rewrite.
- Open no GitHub issues. The repo is public at github.com/ShaulLavo/bun-wasm. The site deploys from `site/` with `bun run deploy`.

## Docs

- Public docs live in `README.md` and `docs/`. Plans, measurement dumps and working notes live in `.internal/`. Never link `.internal/` from the README or `docs/`.
- `docs/app-matrix/` and `docs/bun-test-suite/` are tool-owned: scripts write and read them at those paths. Edit the generated tables only through `bun scripts/refresh-compatibility-docs.ts`, and run it with `--check` after any change in those directories.
- Source and scripts cite `docs/host-abi.md`, `docs/engine-browser.md`, `docs/stack-limits.md` and `docs/bun-patches.md` by path. Keep those paths.

## Direction (owner, 2026-10-15)

- The public site is a demo. Its sandbox bundles React with bun.wasm and caches the result in the browser. It ships no pre-built React bundle.
- A future product (a StackBlitz-style IDE, to be discussed) will probably ship React pre-built, because nearly every project wants it.
