# Same-realm hot server runs

Class **Host feature**, **original adapter**. No Bun, Node or engine implementation is copied. The behavior reference is Bun 1.4.4's file-based `bun --hot run` command. Bun's native CLI and server implementation at `9510e74152073d850a18758ca41114d8f214ffa6` provide the comparison, not code imported into this adapter. The supported subset is documented in [Hot server runs](../hot-run.md).

`hot_run.rs` reads strict owned snapshots, hashes the bytes actually compiled, reuses the existing preparation/registration compiler and returns graph-owned raw source-map strings. It does not populate or purge ordinary module caches. `hot_run.ts` owns directory interests, serialized attempts, registration sessions, cancellation and diagnostic lookup. The ordinary loader's factory captures intrinsics once and creates private sessions without replacing the process import hook.

`hot_serve.ts` stages callbacks under private async-context generation provenance. Matching evaluations reuse the actual `net.js` server and listener. `hot_request.ts` pins the callback, present or absent error handler, registration frame and graph through request output or connection teardown. Provisional failure closes only its newly created listener. A failed replacement cannot close a committed listener.

`hot_revisions.ts` supplies a private synchronous committed-stamp subscription for later development clients. Each actual listener has a fresh instance token. Requests retain their own immutable committed stamp. Subscribers cannot change generations or obtain graphs. Failed, stale and canceled attempts publish nothing. Observer failures do not undo a server commit.

The shared decoder maps raw graph-owned mappings through a stateless native call. Bootstrap formatting, inspect and the browser script-evaluation mapper preserve the raw hot identity until mapping and excerpt selection. Released identities never fall back to today's file maps or source. This changes no Engine trait, fixed split operation, native engine archive, Wasm memory-group contract or host watch ABI.

Feature-owned source checks cover parser semantics, session isolation, graph preparation, watcher recovery, error retention, stale commits, cancellation, request leases and revision subscriptions. The native CLI fixture uses real filesystem edits and HTTP requests. Source checks alone do not qualify a guest or browser. The server gate is distinct from browser document updates.
