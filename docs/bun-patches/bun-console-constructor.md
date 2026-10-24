## Bun Console constructor

`crates/bunwasm-runtime/src/js/bun_console_constructor.js` is generated from
Bun's `src/js/builtins/ConsoleObject.ts`, function `createConsoleConstructor`,
at revision `9510e74152073d850a18758ca41114d8f214ffa6`. Bun attributes this
constructor to Node's `lib/internal/console/constructor.js` at
`d2c7c367741bdcb6f7f77f55ce95a745f0b29fef/lib/internal/console/constructor.js`.
The existing generated-builtins directory contains Bun's license.

`scripts/generate-bun-console.mjs` removes TypeScript and lowers dollar intrinsics
to a lexical adapter. It preserves the constructor body, including both overloads,
stream writes, method binding, per-instance state, inspect options, colors,
groups, timers, and tables. `--check` checks reproducibility against the pinned
source. This function is a Bun global-object builtin, outside its module registry.
Bun's `src/js/node/console.ts` only exports the global singleton, so switching
that module's factory cannot supply the missing constructor.

`src/js/console_constructor.ts` is an original adapter. It supplies ordinary
JavaScript brand checks, uncurried calls, validation errors, and Bun's existing string-width API. Its public dependencies use the runtime's
builtin module registry. The ordinary polyfill loader compiles the generated
function on first access to `console.Console`. The global singleton keeps its
Bun formatter; new instances use Bun's Node Console and existing Node inspector.
`src/js/console.ts` adds the lazy constructor and the global stdio properties.
The strict TypeScript conversion of these two handwritten adapters adds typed
formatter arguments, native output bytes, timer state, validator inputs and
uncurried intrinsic calls. It preserves the executable AST, strict directives,
native error constructors and token line/column positions after Node type erasure.
The comparison source is `ac43127c85addabed7e0c2a4883247ae074e858c`.
The generated constructor and its generator are unchanged. Neither handwritten
adapter copies additional upstream source.
The original `src/js/bun.js` adapter now derives `Bun.enableANSIColors` from
FORCE_COLOR, NO_COLOR, and stderr's TTY state. Bun's Console reads this flag
when automatic color mode encounters FORCE_COLOR; the old constant false
prevented forced colors on every engine.

The generated constructor also embeds Bun's
`src/js/internal/util/debuglog.ts` time formatter, with its default export
replaced by the constructor's lexical require. The formatter retains Bun's
Node v26.3.0 adaptation, including minute and hour output. No local formatter
approximates the upstream implementation.

The generator also routes the constructor's `Error.captureStackTrace` call to
an original adapter. JSC's bare stack strings omit the Trace name and message;
the adapter prepends them while preserving stack frames. Browser engines
without captureStackTrace use Error.stack. It leaves a native Node-style
header and a custom prepareStackTrace result intact. This supplies the Node
console contract without changing the engine's global Error constructor.

Bootstrap captures its default stack formatter identity for this adapter.
An installed user formatter stays authoritative; the runtime's own default
frame-only formatter still receives the Console Trace header.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`src/js/bun_console_constructor.js`](#bun-console-constructor) | Port | Generate Bun's Console constructor with lexical engine-independent hooks. |
| [`scripts/generate-bun-console.mjs`, `src/js/console_constructor.ts`, `src/js/console.ts`](#bun-console-constructor) | Host feature | Original generation and runtime adapters expose the shared constructor and its streams. |

[Ledger scope and pinned revisions](scope.md).
