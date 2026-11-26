# Preview origins

A preview normally lives under the IDE page's own origin, at `/__preview/<port>/`. An app that
expects to own `/` (root-relative assets, `fetch('/api')`, `history.pushState('/dashboard')`,
cookies on `/`) then needs per-template adjustments, and it shares the IDE's cookies and storage.

With preview origins, each listening port of a workspace gets its own origin:

```
https://<id>-<port>-pv.<domain>/        https://k3q9…x2m4-5173-pv.sprockt.dev/
```

The app runs at `/` there with its own cookies, storage and service worker scope. Nothing changes
in the app, and no request passes through a server: a service worker on the preview origin relays
every request over a `MessagePort` to the IDE tab that runs the dev server. Mounted `/__preview/`
previews stay the default wherever no preview domain is configured.

## Try it locally

```sh
bun web/build.ts && bun web/serve.ts      # or the sandbox: ROOT=sandbox/dist bun web/serve.ts
```

Open the printed address on `localhost` with `?preview-origin`. Previews then load from
`<id>-<port>-pv.localhost:<port>`, which every browser resolves to this machine. The parameter also
takes a domain (`?preview-origin=app.localhost:4173` with the page on `ide.app.localhost:4173`). It
is honored only on a loopback or `.test` page host, and only for a preview domain under `localhost`
or `.test`: the page hands each preview origin a port to its dev server, so a link must never choose
a public place for it. A public domain comes from the build and from nowhere else:
`BUN_WASM_PREVIEW_ORIGIN=sprockt.dev bun web/build.ts`.

## How a request travels

```
preview frame ── fetch ──> service worker of the preview origin ── MessagePort ──> IDE tab ──> dev server
```

1. The IDE page (`RootPreviews`) derives the origin, binds Waffle's root relay for that port, and
   mounts one hidden relay frame at `/__bunwasm-preview/relay.html` on the preview origin.
2. The relay frame registers the origin's service worker and tells its parent it is ready. The IDE
   answers with a `MessagePort`; the relay forwards it to the worker; the worker confirms on the
   port, and uses it once the IDE has answered there. Only then is the preview shown. A dev server
   that restarts keeps its relay frame and gets a new port; the IDE closes the old one only after
   the worker confirmed it (WebKit ends a page's process when a port is closed while its other end
   is still in transit).
3. The worker serializes each request (method, unchanged URL, header pairs, buffered body) to the
   port. The IDE hands it to Waffle with the port's one grant and streams the response back.
4. Browsers stop idle service workers and drop their ports. A worker without a port asks the relay
   frames it can see for a new one, and the IDE supplies a fresh channel for the same server.
5. When several tabs share a workspace, the tab that owns the dev server attaches the relay. The
   other tabs' preview frames use the same origin and are served through that tab.

A service worker cannot carry WebSockets, so every HTML document gets one injected script. It
replaces `WebSocket` for the preview's own origin and opens the socket over a port that runs from
the page to the IDE directly, so a hot-reload connection outlives a service worker restart.

A port gives no sign when the tab at its other end is gone, except in Chromium. An open socket
therefore pings the IDE tab every 15 seconds and fails after two unanswered pings, and the IDE ends
the server's connection for a page it has not heard from for 150 seconds. The IDE reads a socket's
whole response head (64 KiB at most) and removes `Set-Cookie` before any of it reaches the page; a
longer head fails the socket.

## Trust

The whole preview origin is untrusted: the app's code runs there. The capability is the
`MessagePort`. Its handler in the IDE page holds exactly one Waffle grant and supplies it itself,
so nothing sent from the preview origin can select another port, workspace or owner. A request
with an unknown `credentials` value or a header that is not a valid HTTP header is refused, and any
other malformed message is dropped, before it reaches Waffle. The relay frame takes ports only from an allowed
IDE origin, and `frame-ancestors` keeps other sites from framing the preview host's own pages.

## Cookies

Browsers drop `Set-Cookie` from service-worker responses and hide `Cookie` from them, so the IDE
page keeps each preview origin's cookie jar. It adds `Cookie` to requests and socket upgrades and
removes `Set-Cookie` before a response crosses to the preview origin. HttpOnly values never reach
the page. `document.cookie` and `cookieStore` read a script-visible mirror, and a script write is
applied before any later request leaves. The browser's own cookie store stays empty for preview
origins, so behavior does not depend on a browser's third-party cookie rules. A persistent
workspace keeps its jars in the IDE origin's `localStorage`; a memory workspace forgets them.

`SameSite` is recorded but not enforced: a preview is always first-party to itself.

## Names

`id` is the full SHA-256 of the IDE origin and the workspace's identity, in base32 (52 characters).
A persistent sandbox workspace stores a random identity in `~/.bun-wasm/preview-identity`, so all
its tabs agree and a deleted workspace starts over with new origins and no cookies. A memory
workspace and the playground use the tab's identity.

## New tabs

A top-level tab on a preview origin cannot reach the IDE tab's relay in every browser (Safari keeps
a frame's service worker apart from a tab's, even on one site). "Open in a new tab" therefore opens
`preview-frame.html` on the IDE origin, which frames the preview. A direct visit to a preview host
gets a `403` page that says to open it from the IDE, from the static host and from the origin's
service worker alike, so the app and its cookies are never served to a tab outside the IDE. The new
tab works while the IDE tab that runs the server stays open.

Tabs the app opens itself go the same way. The IDE names its wrapper page when it attaches, and the
injected script points a same-origin `target="_blank"` link, a Ctrl, Cmd, Shift or middle click on a
same-origin link, and a same-origin `window.open` call at that page for the requested URL. The
browser still performs its own click, so user activation and background tabs work as usual, and
the link's `href` is the app's own again right after. An IDE with its own wrapper page must take
the preview in its `url` query parameter, as `showPreviewFrame` does.

## Hosting

The preview host serves four fixed files and nothing else (`handlePreviewOriginRequest`):

| Request | Response |
| --- | --- |
| `/__bunwasm-preview/sw.js` | the service worker, scope `/` |
| `/__bunwasm-preview/relay.html` | the relay page |
| a framed navigation | a page that registers the worker, then navigates once |
| a top-level navigation | `403`, "open this from the IDE" |
| anything else | `503` |

`web/serve.ts` answers preview hosts on its own port. For Cloudflare, `site/preview-worker.ts` with
`site/wrangler.preview.jsonc` is a separate small Worker on `*-pv.sprockt.dev/*`, so a preview
host is never answered with one of the IDE's files. It is not part of `bun run deploy`.

Production previews are same-site with the IDEs (`bun.sprockt.dev`, `sprockt.dev`). Preview code
can therefore set `Domain=sprockt.dev` cookies and make same-site requests. Services on that
domain must use `__Host-` cookies and check the exact `Origin` on authenticated endpoints.

## Dev servers and the Host name

Waffle forwards the public Host name. Vite refuses names it does not know, except loopback ones,
so the sandbox and playground set `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` to the preview domain.
A server with its own allow-list needs the preview domain added by hand.

## Using it from another IDE

```ts
import { RootPreviews, handlePreviewOriginRequest, showPreviewFrame } from "bun-wasm/preview-origins";

// IDE page. `identity` must be the same in every tab of a workspace and new for a recreated one.
const previews = new RootPreviews({ config: { domain: "sprockt.dev" }, identity: workspaceId, persistCookies: true });
const token = previews.registerListener(port, server);          // on the runtime's "listening"
if ((await previews.waitUntilRegistered(port, token)) === "ready") frame.src = previews.url(port, "/");
link.href = previews.linkUrl(port, "/");                        // the new-tab wrapper page

// Preview hosts (a Worker or Bun.serve). The files are in bun-wasm/preview-origins/assets/.
const response = handlePreviewOriginRequest(request, { domain: "sprockt.dev", ideOrigins: ["https://sprockt.dev"], asset });

// The IDE's own wrapper page, when it does not use the built preview-frame.html.
showPreviewFrame({ domain: "sprockt.dev" });
```

`previews.watchFrame(frame, { loaded, failed })` tells when a preview frame settled. A cross-origin
frame's `load` event fires for its initial blank document, the cold-load page and error pages too,
so three things settle it: the page's own report (HTML pages get it with the injected script); the
service worker's error page, which reports a failure and whether a retry is worth it; and, for a
document that cannot report (plain text, an image, a page whose policy keeps the script out), the
frame's `load` event once the server sent the final response of that frame's own navigation: the
response to the frame's address, followed through its redirects. The tab that runs the server
tells the workspace's other tabs about those responses on a `BroadcastChannel`, so a tab that only
shows the preview settles by the same rule.

The injected script must pass every Content-Security-Policy of the response (a proxy's and the
app's). Its tag carries a nonce that all policies asking for one accept. When no single tag can
pass, for example with a hash-only policy, none is written and no policy is widened: the page
loads without WebSocket and `document.cookie` support.

## Limits

- Workers inside a preview cannot open WebSockets to the dev server yet.
- A response slower than WebKit's service-worker fetch limit (about 70 seconds before headers) is
  not held open by a loading page as mounted previews do.
- An app's own service worker is not registered: the preview's worker carries every request.
- A tab the app opens is the wrapper page, another origin: the app cannot script it, and
  `window.opener` is not set. A form with `target="_blank"`, "open link in new tab" from the
  browser's context menu, and a later navigation of an `about:blank` popup still reach the preview
  origin directly and get the `403` page. A `target="_top"` link navigates the IDE tab itself.
- The older loopback host (`?root-previews`, `PREVIEW_ORIGINS=1`) is unchanged and still serves the
  native runs that use it.

Tests: `web/tests/preview-origin-*.test.ts` and `scripts/isolated-preview-origins-browser.test.ts`
(Chromium, Firefox and WebKit; same-site, cross-site and a public-shaped hostname). The browser
test reads preview documents through a postMessage probe in the app, because Playwright does not
see every preview frame in Firefox.
