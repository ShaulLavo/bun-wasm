## CommonJS Module compilation

Class **Host feature**, **original adapter**. `bootstrap.js` adds `Module.prototype._compile`
through the TypeScript `module_compile.ts` factory. No Node or Bun implementation is copied.
The runtime build discovers the factory through `build/polyfills.rs` and erases its types with
`scripts/transpile-runtime.ts`, just like the other TypeScript runtime factories.

The adapter compiles a CommonJS body with five formal parameters, then calls the existing
module wrapper dispatcher. It preserves the exports receiver, module object, local require,
filename, directory, explicit return value, and thrown value. It does not insert a manually
compiled module into the require cache or mark it loaded. These choices follow Node 26.12.1.
Native Bun 1.4.4 differs in receiver, explicit return value, loaded state, hashbang handling,
and instance-require overrides.
The tests record those differences rather than claiming full native Bun parity.

The factory captures the original Function intrinsic during bootstrap. It validates argument
types and parses the body with the same five parameters before filename-aware evaluation.
Parsing cannot execute the body. This rejects malformed bodies before either module effects
or evaluation outside the wrapper. Rejected syntax keeps its original error and gains the
supplied filename in its stack without evaluating the rejected source. A leading BOM and
hashbang follow the Node control, including U+2028 and U+2029 hashbang terminators.

The wrapper uses the existing two-header-line CommonJS layout and starts evaluation at line
-1, so source line 1 and its columns remain unchanged. The native `evalScript` closure forwards
an optional numeric first line to the existing Engine method and otherwise uses line 1.
The browser host's `script-evaluation.ts` adapter records explicit per-filename line offsets
for its existing position mapper because indirect eval cannot set a first line. It captures
the original mapper before installing the adapter, delegates ordinary positions unchanged,
and clears an explicit offset when that filename is evaluated at the default first line.
The focused host checks execute the actual `valueNatives` and `evalAt` methods with the
production factory. They check filenames, repeated compilation, and module isolation.
Invalid argument checks are adapter-specific. Node's private `_compile` can abort on a
non-string input, so the regression does not send invalid values to the native oracle.
The existing six-argument transpiler-wrapper path remains separate and unchanged except
that its return value now reaches its caller.

`scripts/fixtures/module-compile/next-require-hook.txt` is an **unmodified upstream fixture**,
not a runtime shim. It contains the complete published
`next/dist/build/next-config-ts/require-hook.js` from Next 15.5.6 and Next 16.4.3.
Both cached packages contain identical bytes, SHA256
`9e9d766f499ebd65d83f8356c9345379d9c31c9be094c45145dc6433ca907540`.
The cached npm tarball SHA256 values are
`b164a2a51bff93b19ccf0abbb7bd25d4868aa6926a0573dee5e40e4c76864964` and
`d37409b7530c4873cd14c0619a7b8734777fd0dc2cae627bb592e5a82f74f8f4`.
The fixture retains upstream comments and the source-map reference.
`next-license.txt` retains the package's unmodified MIT license. Tests execute its
actual `requireFromString` export through the production bootstrap and builtin registry.
The factory in these tests is emitted by the actual production type-erasure script.
They do not activate its extension hooks or claim a complete Next application pass.

### Overview rows

| Local source | Classification | Purpose |
| --- | --- | --- |
| `src/js/module_compile.ts`, `module_compile_types.d.ts`, `bootstrap.js`, `engine_natives.rs`, `runtime.d.ts` | Host feature, original adapter | Compile supplied CommonJS bodies through the existing engine evaluator and wrapper caller with original source positions. |
| `web/src/script-evaluation.ts`, `web/src/engine-host.js` | Host feature, original adapter | Preserve explicit script line offsets through the browser host position mapper. |
| `scripts/module-compile*.ts` | Host feature, original test adapter | Native Node and Bun controls plus production factory regressions. |
| `scripts/fixtures/module-compile/next-require-hook.txt`, `next-license.txt` | Unmodified upstream fixture | Exact Next 15.5.6 and 16.4.3 config loader regression. |
