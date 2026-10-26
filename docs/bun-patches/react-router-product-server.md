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
