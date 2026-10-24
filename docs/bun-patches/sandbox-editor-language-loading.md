## Sandbox editor language loading

`sandbox/src/main.ts` loads HTML and CSS editor extensions when a matching file opens,
not when the TypeScript starter opens. This is original bun-wasm glue, with no copied
upstream implementation or upstream revision. It calls the unchanged public APIs in
`@codemirror/lang-css` 6.3.1 and `@codemirror/lang-html` 6.4.12 from `sandbox/bun.lock`.
The existing editor-state cache and open revision guard also cover the import wait.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Sandbox editor language loading](#sandbox-editor-language-loading) | Host feature | Original demand-loaded editor extensions over unchanged CodeMirror packages. |

[Ledger scope and pinned revisions](scope.md).
