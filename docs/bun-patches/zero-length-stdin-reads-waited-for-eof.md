### Zero-length stdin reads waited for EOF

`crates/bunwasm-runtime/src/natives.rs`, native `read` callback. A zero-length stdin read called `std::io::stdin().read` with an empty buffer. Rust's buffered stdin reader fills its internal buffer when empty, causing an 8 KiB WASI read that waits for input or EOF. `fs.readSync(0, new Uint8Array(0), 0, 0, null)` therefore hung on an open pipe. Native Bun 1.4.2 returns `0` immediately.

Return an empty byte result for fd 0 before entering buffered stdin when the requested buffer is empty. Other fds use unbuffered `File::read` after lookup in our fd table, so they do not have this buffered-stdin cause. Their error and seek paths are preserved. Callback `fs.read` and promise `FileHandle.read` delegate to `readSync`, which calls this native. `readv` and `readvSync` are not implemented. Full-stream `readStdin` intentionally reads until EOF and is a different operation.

QuickJS, JSC, and the browser-host engine install the same native table, so the fix applies to all three. No Bun or third-party source changes for this fix. The fixture `tests/fixtures/fs-empty-read` covers empty and nonempty destination buffers with zero requested length, options, regular files, invalid descriptors, callbacks, and promises. `tests/test-empty-stdin.py` holds a pipe open until the guest exits and kills and reaps it on timeout. Closing the pipe as test input would conceal the defect.

The normal `scripts/test.sh` runner uses the open-pipe driver for this fixture. Reproduce under wasmtime with `source env.sh && python3 tests/test-empty-stdin.py`. The same test accepts `--engine native`, `--engine jsc`, and `--engine browser`; browser runs the host-engine wasm through Node's V8 and WASI host. This is an engine-host regression, not a browser UI test.


[Parent context](port-bugs-fixed-in-bun-wasms-own-code.md).
