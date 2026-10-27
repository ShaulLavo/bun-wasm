# Runtime environment reads

Classification: adapted Bun runtime initialization, with an original regression fixture.

Upstream: `oven-sh/bun` revision `9510e74152073d850a18758ca41114d8f214ffa6`, `src/runtime/cli/run_command.rs` and `src/bundler/options.rs`.

`crates/bunwasm-transpiler/src/lib.rs` uses Bun's `LoadAllWithoutInlining` environment behavior for module execution, as Bun's run command does. It disables default environment-file loading because the host runtime owns the process environment. Runtime parsing preserves `process.env.NODE_ENV` and `process.env.BUN_ENV` reads, including when an async module needs printing for the browser engine's await hooks.

The public `Bun.Transpiler` path keeps its existing `Disable` behavior. Its default development define and explicit user defines still apply to generated code.

The original `tests/fixtures/runtime-environment` fixture uses the environment decision from Vite 7.1.12's `dist/node/chunks/config.js`: check whether `NODE_ENV` is set, assign the default when absent, derive `isProduction`, and select `jsxDev: !isProduction`. The surrounding fixture and live-environment/public-define assertions are original adapters. The Vite package archive SHA256 is `85f5144ff94a0ee96ae48b142fb4f26a704381723702c6acd467020d43c657bf`.

This fixes an incorrect production-mode decision before JSX transformation. It does not change React exports or package resolution. Application acceptance requires a later authorized production run.
