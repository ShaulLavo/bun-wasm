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
exports through ESM, import.meta.require, and createRequire. It also checks
builtin detection and resolve paths, then runs a real message and close
handshake. It runs with the standard fixtures on all three engines, through
both CLI ABI slot paths, and inside Chromium and WebKit across all engines.

`scripts/test-net-ws.sh` separately loads the pinned package by its explicit
relative entry path. This prevents the builtin from replacing the package
control. Standard browser and sandbox HMR gates exercise the existing preview
WebSocket bridge too.

The framework rows that previously stopped on the missing ws import are
recorded after an offline matrix replay. The replay needs the Rollup wasm
support from PR #8; the builtin does not supply that separate dependency.

## Compatibility comparison

The four files in Bun's `js/first_party/ws` were measured before and after with
15-second file limits, two-second initial test limits, private loopback network
namespaces, and unchanged source at `ddab8382bdf6b02f22653758d901fb83ceb85aa8`.
The before run can load the installed package. The isolated builtin fixture
separately reproduces the missing-package failure and then proves builtin use.

| Engine | Observed passes before | After | Fully passing files before/after | File timeouts before/after |
| --- | ---: | ---: | ---: | ---: |
| QuickJS | 6 | 31 | 0 / 0 | 0 / 1 |
| JSC | 6 | 30 | 0 / 0 | 0 / 1 |
| Browser | 6 | 31 | 0 / 0 | 0 / 1 |

All six previously passing upgrade-event cases remain passing on every engine.
The larger ws file previously stopped on a missing `Server` export from the
package's ESM wrapper. It now collects and reaches later tests, including child
IPC that our process ABI cannot provide. It exceeds the bounded file deadline.
Other first blockers include private fault-injection hooks, proxy support,
HTTP error-response handling, and Bun-specific diagnostics. These counts do
not establish complete ws API conformance.

The 28-file TCP and Node harness comparison retains all nine formerly passing
files on every engine. All five raw Node assertion scripts still pass. Raw
`ws-before-*`, `ws-fixed-after-*`, and `ws-fixed-net-*` records remain with the
review evidence under `/work/reports/bun-wasm-tcp-2026-10-16/` until acceptance.


The [offline framework replay](app-matrix/ws-results.md) clears the missing ws
import in all 22 previously affected command rows. All 18 installs pass; the
33 complete commands reach later blockers and still fail. No framework source
or installed package implementation was changed.
