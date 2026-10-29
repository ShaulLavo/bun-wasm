## Package-script defaults and HTTP ports

Class **Host feature**, **original adapter** changes in
`crates/bunwasm-runtime/src/js/package_scripts.ts` and `net_port.ts`, with
minimal call-site wiring in `net.js` and `net_address.ts`. No upstream
implementation is copied or patched.
The package-command and TCP adapters retain their existing provenance in
[package commands](portable-installer-and-package-commands.md) and
[TCP helpers](tcp-and-ip-helpers.md). Their Bun comparison revision is
`9510e74152073d850a18758ca41114d8f214ffa6`.

Package-script argument expansion now recognizes `${NAME:-word}` for unset or
empty variables and `${NAME-word}` for unset variables only. It preserves zero,
single-quoted and escaped dollar signs, double-quoted whitespace, and the
existing `$NAME` and `${NAME}` forms. The fallback uses the same argument reader,
including variable expansion and quote removal. Unsupported parameter operators,
nested braced expansion, and command substitution fail before executable
admission instead of reaching a consumer as literal text. This remains a bounded
argument adapter, not a complete shell or a replacement for Waffle's shell.

The HTTP server passes the original port option to the shared typed TCP port
validator before registering a listening callback or calling the native host.
Nullish ports retain the zero default, numeric strings normalize to numbers,
and invalid numbers throw synchronously. Invalid option types receive
`TypeError` with `ERR_INVALID_ARG_VALUE`. Invalid numeric values and strings
receive `RangeError` with `ERR_SOCKET_BAD_PORT`. The shared validator also rejects
whitespace-only strings. The dependency-free `net_port.ts` factory owns
`error`, `port`, and `httpPort`; `net_address` re-exports the same error and port
functions. The runtime-module declaration records their exact callable signatures,
and `net_port_types.d.ts` declares the new helper without embedding declaration
files. The IP predicates in `net_address.ts` are unchanged. Actual host bind
failures still emit an asynchronous error through the existing next-tick path.

`scripts/package-port-expansion.test.ts` executes the checked-in production
factory against `/bin/sh` and native Bun 1.4.4 package-script controls for unset,
empty, set, and zero-valued variables. Quoting and escape cases use shell
controls. `scripts/package-port-http.test.ts` executes the actual HTTP and
address factories with a recording native boundary. Native Node 26.12.1 controls
confirm the synchronous invalid-port contract and valid ephemeral loopback
listeners. Native Bun 1.4.4 HTTP instead emits `ERR_OUT_OF_RANGE` asynchronously
for invalid numeric ports. This adapter follows the Node-style contract already
used by its `node:net` server, not that Bun-specific behavior.

`scripts/package-port-typed.test.ts` runs the real Node runtime stripper, checks
that `net_address` re-exports the emitted helper's exact functions, and compiles
the actual typed factory against both module declarations. Negative probes reject
incorrect constructor, error-code, result, and module-name contracts. The runtime
embedding test includes `net_port` in its TCP factory chain assertion. The
separately named declaration file stays visible to TypeScript's project discovery
and is excluded from runtime embedding.

The regression manifests belong to the runtime CI owner and local-runtime
selection. Adjacent HTTP, `node:net`, and TCP factory controls cover the shared
validator consumers. `node:dgram` remains explicitly unsupported and supplies no
UDP coverage. Source and native controls do not establish rebuilt guest or Vite
product acceptance.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Package-script argument defaults](#package-script-defaults-and-http-ports) | Host feature | Original default-word expansion and rejection of unsupported parameter syntax. |
| [HTTP port admission](#package-script-defaults-and-http-ports) | Host feature | Original HTTP wiring to the shared TCP validator before native host calls. |

[Ledger scope and pinned revisions](scope.md).
