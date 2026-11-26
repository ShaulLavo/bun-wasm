# Preview origins

By default, a preview runs under the IDE's origin at `/__preview/<port>/`. An app that expects to
own `/`, using root-relative assets, `fetch('/api')`, `history.pushState('/dashboard')`, or cookies
on `/`, needs per-template fixes and shares the IDE's cookies and storage.

With preview origins, each listening port in a workspace gets its own origin:

```
https://<id>-<port>-pv.<domain>/        https://k3q9...x2m4-5173-pv.shaulavo.dev/
```

The app runs at `/` with its own cookies, storage, and service worker scope. The app needs no
changes, and no request hits a remote server. A service worker on the preview origin relays
requests over a `MessagePort`, a direct browser channel, to the IDE tab running the dev server.
Mounted `/__preview/` previews stay the default without a preview domain.

## Try it locally

```sh
bun web/build.ts && bun web/serve.ts      # or the sandbox: ROOT=sandbox/dist bun web/serve.ts
```

Open the printed address on `localhost` with `?preview-origin`. Previews load from
`<id>-<port>-pv.localhost:<port>`, which browsers resolve locally. You can pass a domain, like
`?preview-origin=app.localhost:4173` from `ide.app.localhost:4173`. The IDE honors `?preview-origin`
only on `.test` or loopback hosts like `localhost`, `127.0.0.1`, and `[::1]`, and only for preview
domains under `localhost` or `.test`. Because the IDE gives each preview origin a channel to its dev
server, URL parameters cannot pick public hosts. Set a public domain at build time with
`BUN_WASM_PREVIEW_ORIGIN=shaulavo.dev bun web/build.ts`.

## How a request travels

```
preview frame ── fetch ──> service worker of the preview origin ── MessagePort ──> IDE tab ──> dev server
```

1. `RootPreviews` in the IDE derives the origin, binds a root relay in Waffle, the browser runtime,
   and mounts a hidden relay frame at `/__bunwasm-preview/relay.html`.
2. The relay frame registers the service worker and signals ready. The IDE sends a `MessagePort`,
   the relay forwards it, and the worker confirms on it. Once the IDE replies, the worker uses the
   port and the IDE shows the preview. Restarted dev servers keep their relay frame and get a new
   port. The IDE closes an old port only after the worker confirms it, because WebKit crashes the
   page if a port closes in transit.
3. The worker sends each request's method, unchanged URL, header pairs, and buffered body over the
   port. The IDE passes the request to Waffle with that port's single authorization grant and
   streams the response back.
4. Browsers stop idle service workers and drop their ports. A restarted worker asks visible relay
   frames for a new one, and the IDE sends a fresh channel for that server.
5. When several tabs share a workspace, only the tab running the dev server attaches the relay.
   Preview frames in other tabs load the same origin and route through that tab.

Service workers cannot carry WebSockets, so the worker injects a script into HTML documents. It
replaces same-origin `WebSocket` calls with a direct `MessagePort` to the IDE, so hot-reload sockets
survive service worker restarts.

Outside Chromium, a `MessagePort` gives no close signal when the other tab exits. Open sockets ping
the IDE every 15 seconds and fail after two missed pings, while the IDE drops connections silent for
150 seconds. The IDE buffers each upgrade response head up to 64 KiB, strips `Set-Cookie`, and fails
sockets with larger heads.

## Trust

User code runs on the preview origin, so the IDE treats it as untrusted. Only the `MessagePort`
grants access. Its IDE handler holds one Waffle grant and supplies it on every dispatch, so preview
code cannot reach another port, workspace, or owner. Before anything reaches Waffle, the handler
refuses unknown `credentials` values and invalid HTTP headers, and drops malformed messages. The
relay accepts ports only from allowed IDE origins, and a `frame-ancestors` policy stops other sites
from framing preview host pages.

## Cookies

Browsers strip `Set-Cookie` from service-worker responses and hide `Cookie` from their requests, so
the IDE manages each preview origin's cookie jar. It adds `Cookie` to requests and WebSocket
upgrades, and removes `Set-Cookie` before responses cross to the preview origin. `HttpOnly` cookies,
which page scripts cannot read, never leave the IDE. `document.cookie` and `cookieStore` read a
script-visible mirror, and script writes apply before later requests leave. Because the browser's
cookie store stays empty for preview origins, third-party cookie rules do not affect previews.
Persistent workspaces save jars in the IDE origin's `localStorage`; memory workspaces keep them only
in memory.

The jar records `SameSite` without enforcing it because a preview is always first-party to itself.

## Names

The `<id>` label is the 52-character lowercase base32 SHA-256 hash of the IDE origin and workspace
identity. Persistent sandbox workspaces store a random UUID in `~/.bun-wasm/preview-identity`, so
all tabs compute the same origins and deleting the workspace resets its origins and cookies. Memory
workspaces and the playground use the tab's identity.

## New tabs

A top-level tab on a preview origin cannot reach the IDE's relay in every browser. Safari, for
example, isolates a framed service worker from a top-level tab even on one site. "Open in a new tab"
opens `preview-frame.html` on the IDE origin, which frames the preview. Both the static host and the
preview service worker answer direct top-level visits with a `403` page saying to open the preview
from the IDE. That keeps the app and its cookies out of standalone tabs. The new tab works while the
IDE tab running the server stays open.

Tabs the app opens follow the same path. When the IDE attaches, it sends its wrapper page URL. The
injected script redirects same-origin `target="_blank"` links, same-origin links opened with Ctrl,
Cmd, Shift, or middle click, and same-origin `window.open` calls to that wrapper. Because the
browser handles the native click, user activation and background tabs behave as usual, and the
script restores the link's `href` right after. Custom wrapper pages must read the preview URL from
the `url` query parameter, as `showPreviewFrame` does.

## Hosting

`handlePreviewOriginRequest` serves four fixed files for preview hosts and nothing else:

| Request | Response |
| --- | --- |
| `/__bunwasm-preview/sw.js` | the service worker, scope `/` |
| `/__bunwasm-preview/relay.html` | the relay page |
| a framed navigation | a cold-load page that registers the worker, then navigates once |
| a top-level navigation | `403`, telling you to open the preview from the IDE |
| anything else | `503` |

Locally, `web/serve.ts` serves preview hosts on its own port. On Cloudflare,
`site/preview-worker.ts` and `site/wrangler.preview.jsonc` run as a separate Worker on
`*-pv.shaulavo.dev/*` so preview hosts never serve IDE files. `bun run deploy` skips that Worker.

Production previews share the `shaulavo.dev` site with `bun.shaulavo.dev` and other services on `shaulavo.dev`. Preview
code can set `Domain=shaulavo.dev` cookies and send same-site requests. Services on that domain must
use `__Host-` cookies, which browsers lock to one exact host, and verify the exact `Origin` header
on authenticated endpoints.

## Dev servers and the Host header

Waffle forwards the public `Host` header to the dev server. Vite rejects unknown non-loopback hosts,
so the sandbox and playground set `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` to the preview domain.
Other servers with host allow-lists need the preview domain added by hand.

## Using it from another IDE

```ts
import { RootPreviews, handlePreviewOriginRequest, showPreviewFrame } from "bun-wasm/preview-origins";

// IDE page. `identity` must match across workspace tabs and change if the workspace is recreated.
const previews = new RootPreviews({ config: { domain: "sprockt.dev" }, identity: workspaceId, persistCookies: true });
const token = previews.registerListener(port, server);          // on the runtime's "listening"
if ((await previews.waitUntilRegistered(port, token)) === "ready") frame.src = previews.url(port, "/");
link.href = previews.linkUrl(port, "/");                        // the new-tab wrapper page

// Preview hosts, such as a Worker or Bun.serve. Static files live in bun-wasm/preview-origins/assets/.
const response = handlePreviewOriginRequest(request, { domain: "sprockt.dev", ideOrigins: ["https://sprockt.dev"], asset });

// Custom wrapper page, if your IDE does not use the built preview-frame.html.
showPreviewFrame({ domain: "sprockt.dev" });
```

`previews.watchFrame(frame, { loaded, failed })` reports when a preview frame settles. A
cross-origin frame's `load` event also fires for the initial blank document, cold-load page, and
error pages, so `watchFrame` uses three signals:

- The page's load report, sent by the injected script in HTML documents.
- The service worker's error page, which reports a failure and whether a retry can help.
- The frame's `load` event, for documents that cannot report, such as plain text, images, or pages
  whose policy blocks the script. `watchFrame` accepts it only after the hidden relay page of the
  frame's origin looks at that frame and finds a loaded document of the server in it.

The relay page shares the preview's origin, so it can read the frame through `parent.frames`, which
the IDE page cannot. A tab that only shows another tab's server mounts the relay page with
`?inspect` for this check alone. The frame must be a frame of the IDE page itself.

The relay page cannot read a document of another origin: the server redirected the frame away, or
gave the document an opaque origin with a `sandbox` policy. Such a document settles the frame once
the server has sent the final response of that frame's navigation, followed through redirects. The
tab that runs the server tells the workspace's other tabs about those responses over a
`BroadcastChannel`.

The injected script must pass every `Content-Security-Policy` header on the response, from both the
app and any proxy. Its `<script>` tag carries a nonce, a one-time token, accepted by every policy
that requires one. Chromium, Firefox, and Safari differ in how an `http` host source covers an
`https` page, so the worker applies the rule of the browser it runs in. If no single tag passes all
policies, such as under a hash-only policy, the
worker skips injection and leaves the policies unchanged. The page still loads, without WebSocket or
`document.cookie` support.

## Limits

- Web Workers inside a preview cannot open WebSockets to the dev server yet.
- Unlike mounted previews, preview origins do not use a loading page to hold open responses slower
  than WebKit's service-worker fetch limit, about 70 seconds before headers.
- The preview blocks the app from registering its own service worker because the preview worker
  handles every request.
- Tabs the app opens load the IDE wrapper page on another origin, so the app cannot script them. The
  wrapper page clears its `window.opener`. The app keeps its handle to the tab unless the wrapper is
  served with `Cross-Origin-Opener-Policy: same-origin`, as a cross-origin isolated IDE's pages are.
  Forms with `target="_blank"`, the context menu's "open link in new
  tab", and later navigations of an `about:blank` popup hit the preview origin directly and get the
  `403` page. A `target="_top"` link navigates the IDE tab itself.
- The older loopback host enabled by `?root-previews` and `PREVIEW_ORIGINS=1` stays unchanged for
  native runs that use it.

Tests live in `web/tests/preview-origin-*.test.ts` and
`scripts/isolated-preview-origins-browser.test.ts` for Chromium, Firefox, and WebKit across
same-site, cross-site, and public-shaped hostnames. The browser test reads preview documents through
a `postMessage` probe in the app because Playwright does not see every preview frame in Firefox.
