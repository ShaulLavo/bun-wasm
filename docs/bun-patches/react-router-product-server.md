# React Router product server entry

Classification: original test adapter, not an upstream patch or copied implementation.

The product fixture in `scripts/app-matrix/product-fullstack.ts` supplies an original
`app/entry.server.tsx` request handler for React Router 7.9.4 and React DOM 19.1.1.
Its contract follows `@react-router/dev/dist/config/defaults/entry.server.node.tsx`,
published in `@react-router/dev@7.9.4`, whose tarball SHA-256 is
`67db549714a4026137c6528f31cc297ab8b61eed694e74da5866bbe13004e01f`.
No upstream source is copied or changed.

React Router's default entry uses Node's `renderToPipeableStream`. React DOM's
`react-dom/server` export selects `server.bun.js` under Bun, which provides
`renderToReadableStream` instead. Native Bun 1.4.4 reproduces the missing Node
export with these package versions. The original adapter returns a Web-stream
Response, waits for server content, preserves status and headers, and forwards
the request's abort signal. The framework still owns routing and rendering.

Providing the entry also bypasses React Router's default-entry setup, which
otherwise adds `isbot` to the package manifest and launches a second package
install. The fixture needs no bot-detection dependency because it waits for the
complete render for every request. It keeps the official production server and
all SSR query, browser DOM, interaction and HMR assertions unchanged.

The original fixture also sets Vite's `ssr.resolve.externalConditions` to
`['bun', 'node']`. React Router 7.9.4 otherwise supplies Node external conditions
in development, so Vite can select React DOM's Node server entry even when the
process runs under Bun. The explicit conditions select `server.bun.js`, whose
readable export matches the request handler. The `reactRouter()` plugin and all
existing lifecycle checks remain unchanged.

This configuration follows `@react-router/dev@7.9.4/dist/vite.js` and
`vite@7.1.12/dist/node/chunks/config.js`. The Vite tarball SHA-256 is
`85f5144ff94a0ee96ae48b142fb4f26a704381723702c6acd467020d43c657bf`.
No upstream source is copied or changed. This fixture correction does not add
Bun direct-stream support to the browser host or establish an application pass.
