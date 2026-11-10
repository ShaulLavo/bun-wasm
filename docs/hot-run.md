# Hot server runs

`bun --hot run server.ts` re-evaluates a file-based ESM application after an imported file changes. `bun run --hot server.ts` and `bun --hot server.ts` select the same mode. A flag after the file remains an application argument.

Each successful evaluation registers one fetch-only `Bun.serve` call at the same hostname and fixed nonzero port. Updates keep the process, JavaScript realm, globals, actual server object, listener and accepted connections. New requests use the new callbacks and registration context. Requests already running retain their selected callbacks, error handler, context and diagnostic data until their output drains or the connection ends.

The runtime prepares the complete static graph before running application bodies. A compilation failure keeps the previous server callback. Fixing the entry or a dependency starts a fresh attempt. Initial compilation errors also retain a referenced watcher, so the process can recover without a server already running. Missing files and replaced directories retain bounded recovery watches. A host that does not support filesystem watching reports an error and closes hot-run resources. The Node fixture host is one such host. No timer polls files as a substitute.

## Supported inputs

The first subset supports file ESM, static imports, JSON and explicit text imports, re-exports, cycles, top-level await and session-local dynamic imports. Repeated imports in one evaluation share a namespace. Later evaluations get fresh file modules, but builtin exports remain process-owned.

A package script may run its literal `bun --hot run server.ts` command. An outer `bun --hot run dev` request for a package script is not supported. `--watch` restart mode is also unsupported.

CommonJS graphs and file `require`, including `createRequire` and `Module.require`, are rejected in hot application context. Builtin requires remain available. Other excluded forms are eval, stdin, workers, tests, multiple servers, port zero, changed listener addresses, TLS, Unix listeners, routes, HTMLBundle entries and application WebSocket replacement.

## Limits

Only imported files are graph inputs. Arbitrary file reads and separately compiled `Bun.build` inputs are not automatically watched. A late import from a retained old graph reads a newly discovered file's current bytes, not a historical filesystem snapshot. Generated Function, eval and vm imports keep their existing behavior and are not promised to join the hot graph.

Global writes, user timers, sockets, children and explicit `server.stop` calls are application effects. The runtime does not roll them back. An evaluation whose top-level await never settles stalls subsequent updates until process cancellation. Edits queue one follow-up attempt rather than running concurrent evaluators. Initial self-requests that depend on an uncommitted server can likewise stall evaluation.

Diagnostic data belongs to the candidate, committed graph and in-flight requests. Once the last request releases an old graph, a user-retained function can still run, but its old stack may be unmapped and have no excerpt. It never borrows today's physical file map. Browser JavaScriptCore does not provide the same script-evaluation stack locations as imported record modules.

This server feature changes the next HTTP response. It does not inject a browser client or update an already loaded document. A new HTTP response is not evidence that a browser hot-reload goal passed.
