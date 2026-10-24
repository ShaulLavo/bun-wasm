## HTTP socket state

The HTTP server socket facade in `crates/bunwasm-runtime/src/js/net.js` is an
original adapter, with no upstream implementation copied. Its `writable` getter
reads the existing host connection's closed and closing states. Published Koa
3.0.1 checks this Node socket property before sending the response body; an
absent property made a live connection appear unwritable. The lifecycle fixture
checks both an open connection and a connection closed after its response.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/net.js`, HTTP socket state](#http-socket-state) | Host feature | Original HTTP socket writability getter over the host connection state. |
