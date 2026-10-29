# Unix socket adapter

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| Node Unix socket adapter | Host feature | Original path, address and error translation over Waffle's Unix stream handles. |

This is an original adapter, not copied or adapted upstream source. It extends
`node_net.js`, the HTTP code in `net.js`, and the Bun host ABI, with shared policy
in `net_path.ts`. `bun-launcher.ts` and `runner.ts` supply the filesystem scope
and release each retained directory after its helper. No Bun, Node or WebKit upstream implementation is imported.
The starting Bun revision is `404a956ffdf3fbee9c94b4875be0afe3fbe09df5`.

The interface is Waffle's wave-20261029 `unix-design/BUN-HANDOFF.md`, based on
Waffle `63ddc5da0699d6e3ca449eaecb0bc35069c664d9`. It specifies
`NetHost.listenPath(path, { unlinkOnClose })`, `connectPath(path)`, and
`{ family: "Unix", path: string | null }` address JSON. Waffle owns filesystem
names, permission checks, stream queues, wakeups, half-close and unlink leases.
Bun appends host slots 16 and 17 and exposes the same calls to the browser engine.

Relative names join the current process cwd without normalizing dots or symlinks.
NUL names, including abstract names, report EINVAL under this contract. Node
servers expose the requested path in `address()`. Pipe sockets expose no IP
address, family or port. HTTP `socketPath` selects the connection independently
of the request URL path and the agent pool separates socket names.

The Node adapter tests supply the specified path API over existing Waffle stream
bytes. That fixture does not prove filesystem binding, unlink leases, or Nuxt.
The manual `net-unix-path` guest fixture checks echo, half-close and filesystem
unlink with a real provider. The released-provider test runs the Node adapter
against Waffle 0.0.102 from `b8b205b932649b20ec33cf2457b95a7b2b6a1b08`.
It checks a real socket node, UTF-8 bytes, reverse traffic after half-close and
acknowledged unlink. It uses the released compiled runtime and NetHost, with
Bun runtime factories loaded in a worker. The matching browser guest and full
Nuxt playground check remain required. The native Wasmtime host leaves the new slots unavailable;
it does not implement a second Unix socket transport.

The rev-2 handoff also requires `createHelper.pathScope`, with the admitted guest's
filesystem identity and a retained directory capability. `BunNetworkOptions`
forwards that scope without adding authority to guest messages. The launcher obtains an explicitly releasable root from `directoryHandle("/")`
and asks the trusted `service.networkPathScope(context, root.handle)` for the
admitted child's scope. The runner uses its existing filesystem connection.
Failed and cancelled launches release acquired roots; helper cleanup precedes
root release. Scope attachment and authentication remain Waffle's responsibility.
Passing no scope fails with ENOTCAPABLE.


Socket-only unit mocks live in `web/tests/socket-runtime-fixture.ts` and call the
canonical process fixture. The shared process fixture keeps its unexpected-operation
guard; socket tests opt into a directory lease explicitly. Main's request-memory,
terminal-output and filesystem payload fixtures remain the source of those protocols.
