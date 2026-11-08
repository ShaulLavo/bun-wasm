# Metadata in required ES modules

Class **Host feature**, **original adapter**. No upstream implementation is copied.

The browser engine runs a synchronously required ES module through Bun's bundler
with external imports and CommonJS output. Bun's Bun-target output retains
`import.meta`, including inside its five-argument CommonJS wrapper. That output
needs Bun's own evaluator and is not valid input to the browser's script evaluator.
The observed failure is yargs 18.0.0's `build/lib/utils/apply-extends.js`, reached
by Angular CLI 20.3.7. Both Firefox and genuine Chrome reject it.

`crates/bunwasm-cli/src/main.rs` uses the existing bundler define option to lower
`import.meta` to a fresh wrapper parameter. It adds that parameter to Bun's emitted
wrapper. The runtime's existing six-argument wrapper dispatcher supplies the
module's metadata object, including its referrer-relative resolver and require.
Only the internal required-module path changes. Public build output is unchanged.

`crates/bunwasm-transpiler/src/register.rs` reuses its escape-aware name allocator
for this parameter. Literal and escaped source names cannot capture metadata.
Bun's parser applies the define semantically, so strings and regular expressions
containing `import.meta` remain unchanged. The bundler API and wrapper format come
from Bun `src/bundler` and `src/js_printer` at
`9510e74152073d850a18758ca41114d8f214ffa6` with this repository's WASI patches.

`tests/fixtures/require-esm-meta/` is an original TypeScript regression. The
browser guest runs it with both module-store and registration-record loaders.
It checks resolution from a dependency directory, metadata identity, metadata
fields, require, require-cache identity, escaped-name collisions, and literals.
