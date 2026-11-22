# Runtime TypeScript

Write new runtime factories in `crates/bunwasm-runtime/src/js/*.ts`. Keep the existing
expression-factory convention and its own `"use strict"` directive. Use type-only
declarations and imports for types; the loader does not link ESM imports in these
factories. Declaration files belong in `src/js/*.d.ts` and are never embedded.

Cargo's runtime build script runs `scripts/transpile-runtime.ts` in two steps. First
Node.js 24+ erases the types of each `.ts` source with the built-in
`stripTypeScriptTypes` API in `strip` mode. It replaces types with whitespace and
preserves JavaScript tokens, constructor calls, class fields and directives. It does
not print, optimize, bundle or downlevel code. `erasableSyntaxOnly` rejects TypeScript
constructs requiring runtime generation, such as enums and parameter properties.

Second, Bun's transpiler (`--minify-whitespace`) removes whitespace and comments from
every module, `.js` ones included, except `intl.js` and `tz_data.js`. That step changes
no syntax and no names: identifiers, function names, messages and `toString()` output
keep their source spelling, and bare expressions stay. Bun drops `"use strict"`
directives, so the script swaps their text for a placeholder and back. A `/*!` license
comment stays. A module that does not start with its factory expression, or whose
reprinted output would not be smaller, is rejected or kept as it was. The generated
`bun_wrap`, `direct_stream` and `dev_html_client` modules go through the same step.

A `.js` and `.ts` file with the same stem is a build error. `BUNWASM_JS_OVERRIDE_DIR`
replaces sources by filename, including their extension; overrides take the same two
steps. Set `BUNWASM_JS_PRESERVE_POSITIONS=1` to skip the second step for a debugging
build: each token then keeps its source line and column, and `.js` files are embedded
as written.

Install host tools with `source env.sh` and `bun install --cwd web --frozen-lockfile`.
Run `scripts/check-runtime.sh` for strict checking, embedding integration tests,
emission regressions and negative native-type probes. `scripts/test.sh` runs this
gate for every engine, including `--no-build` runs. GitHub CI runs the identical
runtime `tsc -p` command after installing web dependencies, plus the portable
emission and type regressions. Those CI tests need neither Rust nor wasm artifacts.

Existing JavaScript is included with `allowJs`, but `checkJs` stays off. The checker
uses ES and web standard library types plus the guest declarations in `runtime.d.ts`.
It excludes host Node/Bun types. Add precise native and engine contracts as modules
convert; do not add a catch-all `any` native table. Glob's options tuple derives from
the required cwd and positional boolean parameters of its native declaration.

## Error locations

Runtime frames keep the existing `bun-wasm:<module>` filename. The shipped modules are
minified, so a frame's line and column point into compacted code, not into the `.ts`
source. The runtime fixture checks that constructor, match and scan errors still carry a
`bun-wasm:glob:<line>:<column>` frame on all three engines. A host test checks that type
erasure alone keeps every token at its source position.

To read a frame against the source, rebuild with `BUNWASM_JS_PRESERVE_POSITIONS=1`.
Cargo keeps the exact embedded code at
`$CARGO_TARGET_DIR/<target>/<profile>/build/bunwasm-runtime-*/out/runtime-js/<module>.js`.
For JSC and browser builds, use their configured Cargo target directory instead.
To regenerate one module for inspection:

```sh
source env.sh
node scripts/transpile-runtime.ts crates/bunwasm-runtime/src/js/glob.ts /tmp/bun-wasm-glob.js
nl -ba /tmp/bun-wasm-glob.js
rm /tmp/bun-wasm-glob.js
```

No source-map registration or runtime lookup is required. Some runtime modules are still
JavaScript. Convert them to TypeScript as you change them.
