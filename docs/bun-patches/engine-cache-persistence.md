# Verified engine cache persistence

Classification: Original adapter.

Upstream path and revision: none. `web/src/engine-loader.ts` and
`web/tests/engine-cache.test.ts` are original bun-wasm code. No Bun, Node,
WebKit, or browser implementation is copied or modified.

The verified-file loader checks the downloaded bytes against the embedded build
hash before compiling or caching them. CacheStorage persistence runs independently
of preparation. A slow optional write cannot hold verified bytes off the startup
path. `cacheEngine` still owns the write and converts storage errors to `false`.
The cache-stored performance mark appears only after a successful write.

The Response owns its snapshot of the verified bytes before preparation continues.
The asynchronous cache consumer therefore cannot borrow a buffer that compilation
later changes or releases. Existing cache lookup, corrupt-cache eviction, and
integrity rejection behavior is unchanged.

The regression holds a cache write open while the real verified tools loader
prepares its module, then releases the write and checks its bytes. It also rejects
an integrity mismatch before any write starts. The test belongs to the existing
Web test glob.
