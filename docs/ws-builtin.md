# The ws builtin

Bun provides `ws` even when an installed project does not depend on the npm
package. Vite selects that import through `import.meta.require("ws")` when
`process.versions.bun` is present. The runtime now supplies that builtin on
QuickJS, JavaScriptCore and the browser engine.

It exports the unchanged published ws 8.18.3 implementation. WebSocket clients
and servers use the existing Node HTTP upgrade and TCP sockets. They can
exchange messages and finish a close handshake in native hosts and between
guest loopback sockets in the browser. Browser raw internet TCP, TLS sockets,
and Unix sockets retain the limits documented in [TCP support](tcp.md).
The plain message and close paths are checked with compression disabled.

## Generate

Install the pinned development dependency and rebuild the source:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
bun install --cwd docs/bun-test-suite/dependencies --ignore-scripts --linker hoisted --frozen-lockfile
scripts/generate-ws.sh
```

The generator checks the package version and includes its MIT license. An
optional output path lets a reviewer regenerate into scratch and compare with
`cmp`, without changing the checked-in file. Run generation and other heavy
commands through the machine's admission wrapper.

Bun's own ws wrapper depends on private native WebSocket and HTTP server hooks.
The portable published implementation can already use our shared Node APIs.
Its [provenance](bun-patches.md#portable-ws-builtin) is separate from those
original host adapters.

## Verify

`tests/fixtures/net-ws-builtin` has no node_modules. It checks the builtin's
exports, then runs its client and server through a real message and close
handshake. It runs with the standard fixtures on all three engines, through
both CLI ABI slot paths, and inside Chromium and WebKit across all engines.

`scripts/test-net-ws.sh` separately loads the pinned package by its explicit
relative entry path. This prevents the builtin from replacing the package
control. Standard browser and sandbox HMR gates exercise the existing preview
WebSocket bridge too.

The framework rows that previously stopped on the missing ws import are
recorded after an offline matrix replay. The replay needs the Rollup wasm
support from PR #8; the builtin does not supply that separate dependency.
