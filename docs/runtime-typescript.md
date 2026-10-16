# Runtime TypeScript

Write new runtime factories in `crates/bunwasm-runtime/src/js/*.ts`. Keep the existing
expression-factory convention. Use type-only declarations and imports for types; the
runtime loader does not link ESM imports in these factories. Declaration files belong
in `src/js/*.d.ts` and are never embedded.

Cargo's runtime build script calls host Bun through `scripts/transpile-runtime.ts` for
each `.ts` source. Bun strips types without bundling or tree shaking. An explicit
`"use strict"` directive preserves strict execution when the output is evaluated as a
script. Existing `.js` sources are embedded byte-for-byte. A `.js` and `.ts` file with
the same stem is a build error. `BUNWASM_JS_OVERRIDE_DIR` still replaces sources by
filename, including their extension; TypeScript overrides go through the same transpiler.

Install host tools with `source env.sh` and `bun install --cwd web --frozen-lockfile`.
Run `scripts/check-runtime.sh` for strict typechecking and embedding regression tests.
`scripts/test.sh` runs this gate for every engine, including `--no-build` runs.
Existing JavaScript is included with `allowJs`, but `checkJs` stays off. The checker
uses ES and web standard library types plus our guest declarations in `runtime.d.ts`.
It excludes host Node/Bun types. Add precise native and engine contracts as modules
convert; do not add a catch-all `any` native table.

## Error locations

Bun's printer reformats TypeScript. Runtime frames keep their existing
`bun-wasm:<module>` filename and report generated JavaScript lines and columns,
including the leading strict directive. They do not map back to original TypeScript.
Cargo keeps the exact embedded code at
`$CARGO_TARGET_DIR/<target>/<profile>/build/bunwasm-runtime-*/out/runtime-js/<module>.js`.
For JSC and browser builds, use their configured Cargo target directory instead.
To inspect a frame without finding Cargo's output directory, regenerate the same file:

```sh
source env.sh
bun scripts/transpile-runtime.ts crates/bunwasm-runtime/src/js/glob.ts /work/tmp/bun-wasm-glob.js
nl -ba /work/tmp/bun-wasm-glob.js
rm /work/tmp/bun-wasm-glob.js
```

Both engines and the browser evaluate that generated code through the existing loader.
No source maps or additional runtime lookup are required. The remaining conversion
is an Approved follow-up in [the runtime plan](../plans/real-bun-on-our-engines.md#typescript-follow-up).
