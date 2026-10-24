### TCP streams after the portable-core merge

Class **Host feature**, original adapters. `node_net.js` retains the existing TCP transport,
lookup, address, timeout and server behavior. Socket now uses the
portable Duplex's actual readable/writable states and `_read`, `_write`, `_final`
and `_destroy` hooks. Its old public write/end/destroy, byte queues and synthetic
state records are removed. Connection callbacks drive stream callbacks and
`push`; the native read waiter pauses when `push` reaches the high-water mark.
This is original API glue, not copied upstream stream logic.

`net.js` retains the existing Connection shutdown/ref/write callbacks and complete HTTP
upgrade handling. The Streams byte-body producer and HTTP request hooks are
applied to that implementation. Socket and upgrade cleanup run from the real
ClientRequest `_destroy` hook. The host engine releases both native stream
observers and directory cursors at exit. The suite runner retains explicit plain
script selection and opt-in Node assertion scripts without counting registered
Node tests as assertion scripts. The merged TCP fixture exercises successful
Readable.toWeb reads and cancellation of a connected socket.

The original Node-host TCP adapter in `web/scripts/node-net.mjs` now limits each
write to the remaining one-MiB host queue capacity and returns the short byte
count. Checking the queue only before accepting an entire large write allowed
the first write to bypass the limit. The bounded host test fails with that
implementation and passes with capacity-aware writes, including full-queue,
zero-length and owned-copy cases. No upstream implementation is copied.


[Parent context](http-framing.md).
