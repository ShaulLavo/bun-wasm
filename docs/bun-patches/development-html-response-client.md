# Development HTML response client

Classification: original adapter. There is no upstream source or upstream revision for this code.

`crates/bunwasm-runtime/src/js/dev_html.ts` enrolls buffered ordinary HTML responses from an explicitly eligible hot server. It consumes the server's existing read-only committed revision source. It does not own a watcher, graph, listener, commit operation or application request frame.

`web/src/dev-html-client.ts` keeps one author baseline and applies preflighted text and attribute differences to the existing nodes. It retains application listeners and runtime-owned values when their author fields do not change. Unsupported structural, script, policy or conflicting edits leave the current document intact. The external client is generated and minified from that TypeScript source by `scripts/generate-dev-html-client.ts`, then embedded by the runtime build.

The adapter reuses the existing HTMLRewriter and WebSocket implementation. `web/src/sw.ts` only marks its existing preview socket shim so the client can ignore that transport-owned script. It remains a separate transport injector and does not become a hot-update controller.

See [Development HTML updates](../development-html-updates.md) for limits and ownership. Source controls use actual guest Response and Headers with only native parsing/network boundaries replaced. Browser controls use real Chromium and Firefox DOMs, sockets and the generated client. Those controls are distinct from a Wasm guest filesystem-to-document integration and the maintained framework matrix.

A transport disconnect immediately aborts and clears the active update and blocks new notices or application work. Only terminal cleanup is deferred through the owned MessageChannel turn so pagehide can suspend first. Changed inert template contents are rejected during whole-patch preflight; templates are not morphed and cannot silently advance the author baseline. Real browser controls cover held raw replies released by trusted socket close and mixed safe-heading plus unsupported template changes.
