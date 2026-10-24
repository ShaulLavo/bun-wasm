### Bun console formatter

`crates/bunwasm-runtime/src/js/inspect.js`, the Bun formatting factory. Class **Port**. Upstream `src/jsc/ConsoleObject.rs`, `src/jsc/VirtualMachine.rs` (`print_error_instance_body`), and `src/jsc/bindings/bindings.cpp` (`JSC__JSValue__forEachPropertyImpl` and `JSC__JSValue__forEachPropertyOrdered`) at the Bun pin.

Translate Rust and C++ formatting into JavaScript, retaining the estimated-line-length accounting, type-specific rendering, error frames, and property order. Replace direct JSC operations with intrinsic brand checks and host inspection calls. This preserves Bun's console and `Bun.inspect` output across QuickJS, JSC, and the browser engine without the native console bindings. `console.ts` routes output and manages groups, counters, and timers using this formatter. It is an original adapter.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/inspect.js`, Bun formatter](#bun-console-formatter) | Port | Translate Bun's formatter and property enumeration to JavaScript. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
