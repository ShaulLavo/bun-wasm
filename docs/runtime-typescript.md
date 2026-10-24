# Runtime TypeScript

Write new runtime factories in `crates/bunwasm-runtime/src/js/*.ts`. Keep the existing
expression-factory convention and its own `"use strict"` directive. Use type-only
declarations and imports for types; the loader does not link ESM imports in these
factories. Declaration files belong in `src/js/*.d.ts` and are never embedded.

Cargo's runtime build script calls Node.js 24+ through `scripts/transpile-runtime.ts`
for each `.ts` source. The built-in `stripTypeScriptTypes` API runs in `strip` mode.
It replaces types with whitespace and preserves JavaScript tokens, constructor calls,
class fields, directives, and line/column positions. It does not print, optimize,
bundle or downlevel code. `erasableSyntaxOnly` rejects TypeScript constructs requiring
runtime generation, such as enums and parameter properties.

Existing `.js` sources are embedded byte-for-byte. A `.js` and `.ts` file with the
same stem is a build error. `BUNWASM_JS_OVERRIDE_DIR` replaces sources by filename,
including their extension; TypeScript overrides use the same position-preserving strip.

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

Runtime frames keep the existing `bun-wasm:<module>` filename. Their line and column
coordinates identify the same tokens in the `.ts` source because emission adds no
wrapper, directive or reformatted line. Each engine retains its usual constructor
column convention. The runtime fixture checks constructor, match and scan errors
against the source constructor tokens on all three engines. A host test also checks
that its expected fixture locations agree with the current source.

Cargo keeps the exact embedded code at
`$CARGO_TARGET_DIR/<target>/<profile>/build/bunwasm-runtime-*/out/runtime-js/<module>.js`.
For JSC and browser builds, use their configured Cargo target directory instead.
To regenerate it for inspection:

```sh
source env.sh
node scripts/transpile-runtime.ts crates/bunwasm-runtime/src/js/glob.ts /tmp/bun-wasm-glob.js
nl -ba /tmp/bun-wasm-glob.js
rm /tmp/bun-wasm-glob.js
```

No source-map registration or runtime lookup is required. Some runtime modules are still
JavaScript. Convert them to TypeScript as you change them.
