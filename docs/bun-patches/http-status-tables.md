### HTTP status tables

`crates/bunwasm-runtime/src/js/builtins.js` (`STATUS_CODES`) and `crates/bunwasm-runtime/src/js/net.js` (`STATUS_TEXT`). Class **Port** for packaging shared HTTP data. Comparison source `src/js/internal/http.ts` at the Bun pin.

The builtins module retains the status-code/reason table. The network module keeps a smaller reason-phrase table for response output. The callable Node `Stream` constructor and descriptor vectored writes are original adapters, not copied Node implementations. These are standard HTTP values rather than a copied server implementation. Networking, streams, request dispatch, and host transport around the tables are original bun-wasm adapters.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/builtins.js`, `crates/bunwasm-runtime/src/js/net.js`, HTTP tables](#http-status-tables) | Port | Retain HTTP status data separately from the original networking adapters. |

[Parent context](bun-patch-series.md).
