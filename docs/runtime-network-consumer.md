# Bun processes on a caller-owned network

Pass the same `Runtime` to Bun adapter installation and other guest adapters. Bun
roots and descendants borrow separate network helpers from `runtime.network()`.
They share loopback addresses and port reservations, not socket handle numbers.

`BunAdapterOptions.network` supplies an optional `fetch` policy and `listening`
and `stopped` callbacks. Callbacks receive the exact `RuntimeNetworkHelper` that
owns the listener. Use that identity when registering or removing a preview.
The asset loader's `fetch` option still controls guest downloads only. Without a
network override, Bun keeps its existing installer download cache policy.

The playground's `RunOptions.network` uses one page-lifetime observation object
for roots and children. A root's result does not own a child's preview. A session
ends when its own Worker physically stops, after the filesystem admission fence.
Disposing an adapter installation only unregisters future launches. Only the
caller may dispose the Runtime and its whole network. Preview1 remains
network-free. Network ownership never crosses worker messages.

Run the dedicated real-browser gate with an explicit already-built guest:

```sh
NETWORK_CONSUMER_GUEST=/absolute/path/bun-browser.wasm \
NETWORK_CONSUMER_PORT=43829 \
  bun web/tests/browser-network-consumer.ts chromium firefox webkit
```

The gate validates the named IPC guest hash, uses real browser Workers and the
preview service worker, and owns its server, browser profiles and scratch bundles.
It does not build or download a guest. This proves Bun networking integration,
not Next framework development, build or production acceptance.
