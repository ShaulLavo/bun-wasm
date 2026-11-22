### Bun console formatter

`crates/bunwasm-runtime/src/js/inspect.js`, the Bun formatting factory. Class **Port**. Upstream `src/jsc/ConsoleObject.rs`, `src/jsc/VirtualMachine.rs` (`print_error_instance_body`), and `src/jsc/bindings/bindings.cpp` (`JSC__JSValue__forEachPropertyImpl` and `JSC__JSValue__forEachPropertyOrdered`) at the Bun pin.

Translate Rust and C++ formatting into JavaScript, retaining the estimated-line-length accounting, type-specific rendering, error frames, and property order. Replace direct JSC operations with intrinsic brand checks and host inspection calls. This preserves Bun's console and `Bun.inspect` output across QuickJS, JSC, and the browser engine without the native console bindings. `console.ts` routes output and manages groups, counters, and timers using this formatter. It is an original adapter.

An aggregate with no Error members prints its own message and mapped stack. Empty aggregates and aggregates containing Bun.build's plain BuildMessage records previously formatted as an empty string, leaving only the Bun version in fatal startup output. Aggregates with Error members retain their existing child formatting. The source fatal-handler check covers uncaught and unhandled rejection output before exit cleanup; the Browser import-rejection check also runs actual failed builds through package scripts and the terminal.

`Bun.inspect` reads `colors` from the options object or from its second argument, as `FormatOptions::from_js` does, and the formatter wraps primitives, property keys, commas, functions, classes, dates, symbols and `[Circular]` in the escape sequences `ConsoleObject.rs` uses (`<r><yellow>`, `<r><green>`, `<r><d>` and so on). Other nodes, such as Map and Set headers, class names and error frames, print without color. A `NaN` depth now throws like any other non-integer, as `set_depth` does. Nesting past 8192 levels throws the RangeError JSC throws for stack overflow, and an engine's own overflow error is rethrown with JSC's message. Both are local adapters: Bun relies on the native stack. A custom inspector receives `require("util").inspect` as its third argument and, with colors, Node's `stylize`, as Bun's `UtilInspect.ts` does.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/inspect.js`, Bun formatter](#bun-console-formatter) | Port | Translate Bun's formatter and property enumeration to JavaScript. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
