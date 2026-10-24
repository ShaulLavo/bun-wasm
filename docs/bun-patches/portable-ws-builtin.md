## Portable ws builtin

`crates/bunwasm-runtime/src/js/ws_builtin.js` is generated from `index.js` and
`lib/*.js` in the published websockets/ws release `v8.18.3`. Its npm tarball
integrity is
`sha512-PEIGCY5tSlUt50cqyMXfCzX+oOPqN0vuGqWzbcJ2xvnkzkq46oOpz7dQaTDBdfICb4N14+GARUDw2XV2N4tvzg==`,
pinned in `docs/bun-test-suite/dependencies/bun.lock`. The original MIT license
is embedded in the generated source and retained in `third_party/ws/LICENSE`.

`scripts/generate-ws.sh` uses native Bun to bundle those CommonJS files without
changing their implementation. Its original wrapper preserves strict mode,
maps Node imports to the runtime builtin registry, and returns module.exports.
Optional native addons remain external and unavailable. The library's existing
JavaScript implementations handle their absence. The Rust resolver recognizes
`ws` as a Bun builtin; no project dependency is injected. The CommonJS dispatcher
uses the builtin factory registry as well as reserved prefixes, so `require("ws")`,
`createRequire` and `import.meta.require` use the same module as an ESM import.

Bun's own `src/js/thirdparty/ws.js` at
`ddab8382bdf6b02f22653758d901fb83ceb85aa8` requires the private C++ WebSocket
constructor and private HTTP upgrade hooks. Those bindings are not available
on our engines. The portable upstream implementation uses the existing
node:net and node:http adapters instead. It adds no host networking path.
See [the ws builtin](../ws-builtin.md) for generation and verification.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/ws_builtin.js`](#portable-ws-builtin) | Port | Bundle the unchanged published ws implementation for the shared Node APIs. |
| [`scripts/generate-ws.sh` and builtin resolution](#portable-ws-builtin) | Host feature | Original module wrapper supplies Bun's builtin ws import and require on every engine. |
