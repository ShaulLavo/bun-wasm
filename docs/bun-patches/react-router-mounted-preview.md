# React Router mounted previews

Classification: original local adapters. No upstream implementation is copied or
patched. The template retains React Router 7.9.4 and React DOM 19.1.1. Its server
entry contract follows `@react-router/dev@7.9.4/dist/config/defaults/entry.server.node.tsx`.
The relevant rendering and handoff contracts are in
`react-router@7.9.4/dist/development/chunk-WY5IRSCW.mjs` and
`chunk-OIYGIGL5.mjs`.

The mounted proxy forwards `/__preview/5173/` as `/` to the guest. Matching the
guest request at root is correct, but the browser router also needs the public
mount. A client-only basename change renders the page while leaving server Link
hrefs inconsistent with hydration.

`app/preview-context.ts` validates the internal `x-bun-preview-base` mount header,
including canonical encoded hosting directories and Unicode pathnames. The URL
normalization check rejects raw spaces and encoded dot-segment traversal while
retaining the encoded mount in server links and the browser handoff.
After React Router matches the root guest request and runs its loaders, the
adapter derives a rendering context with the public basename and location. It
serializes the same basename into the browser handoff. The original context and
request URL stay unchanged. Without the header it returns the original context,
so ordinary root development and production previews retain their behavior.

Mounted rendering selects React Router's initial route discovery mode. Its full
manifest lets links discover new routes locally. Lazy discovery sends browser
pathnames in a query parameter, which a path-stripping proxy cannot translate.
The template has one route; this policy adds no route payload to the starter.
Root rendering keeps React Router's default lazy discovery mode.

`scripts/react-router-preview-browser.test.ts` and
`web/tests/browser-react-router-preview-main.ts` are original regressions. They install
the real template in scratch, add SSR links and a second route, and run its actual
development server and production build. The mounted variant uses Bun's real
preview service worker and WebSocket shim with a native fixture transport. It
checks SSR hrefs, hydration without errors, loaders, navigation, back navigation,
clicks, and HMR retaining both the document and counter state. It also checks
root development and production behavior and rejects malformed mount headers.
The feature-owned Web browser manifest retains the existing blocking gate.
