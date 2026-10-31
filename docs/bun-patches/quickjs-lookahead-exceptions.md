## QuickJS parser lookahead exceptions

Class **Upstream bug**. This changes `quickjs/quickjs.c` from the QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`. rquickjs-sys 0.14.0 carries the same unfixed code.

`js_parse_skip_parens_token` scans ahead to decide, for example, whether `(` starts an arrow function. It guesses that `/` after any keyword starts a regexp, including a property name such as `l.else / v`. When that guess or a lookahead `next_token` failed, it stopped scanning but left the SyntaxError pending, as its own `XXX: should clear the exception` comments note. The real parse then succeeded, so the stale error surfaced later at an unrelated `JS_HasException` check. `js_host_resolve_imported_module` makes that check before loading the next ES module, so the next import threw the old error. Vite configs of TanStack Start, Nuxt and SolidStart failed this way after loading `@vercel/nft`'s `static-eval.js`.

The lookahead now clears the exception it caused. The real parse still reports every genuine syntax error. The correction is original bun-wasm source. It copies no new upstream implementation and adds no public engine API.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, parser lookahead](#quickjs-parser-lookahead-exceptions) | Upstream bug | Clear the exception a failed `js_parse_skip_parens_token` guess raises, so it cannot be thrown by a later import. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
