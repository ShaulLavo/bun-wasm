# bun:test mock.module

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/bun_test.js` `mock.module`, `mockedModuleKey` | Original adapter | Behavior of Bun's `mock.module` (`src/runtime/test_runner/bun_test.rs` and the `BunPlugin` module registry) |
| `crates/bunwasm-runtime/src/resolve.rs` `register_mocked_file`, `resolve` | Original adapter | None |
| `natives.rs` `registerMockedFile` | Original adapter | None |

`mock.module(specifier, factory)` resolves the specifier from the calling file (the first non-runtime stack frame). When it names a file, the resolver remembers that path: every later import or `require()` that resolves to it, through any specifier, loads a plugin module whose exports are the factory's result. A specifier that names no file, or a builtin, is replaced by that exact name, the same way `Bun.plugin({ setup(b) { b.module(...) } })` registers one. The factory runs once, on first use, and must return the exports object.

Native Bun also rewrites the exports of a module that was already imported. bun-wasm cannot patch an evaluated ES module namespace on every engine, so a module imported before `mock.module` keeps its original exports; call `mock.module` first, or import the module dynamically afterwards, as Bun's documentation shows. Async factories are rejected with a clear error.

`tests/fixtures/bun-probe-test` mocks a file through two specifiers and a CommonJS `require()` on every engine.
