# Preview origins

Classification: original Bun consumer adapter. It copies or adapts no upstream code. It consumes
Waffle's exported root-preview relay and wire dispatcher unchanged from `@waffle-os/runtime`
0.0.150: `PreviewRouter` in root mode, `PreviewHostDispatcher`, `PreviewHostOpen`,
`PreviewHostInput`, and `PreviewHostOutput`. See [Preview origins](../preview-origins.md) for the
user-facing behavior.

## Original adapters

| File | Role |
| --- | --- |
| `web/src/preview-origin/protocol.ts` | Hostname shape, origin ID, configuration, and validated message shapes for every hop |
| `web/src/preview-origin/root-previews.ts` | IDE manager for one relay frame per origin, one port per listener generation, and readiness |
| `web/src/preview-origin/port-session.ts` | IDE `MessagePort` handler bound to one Waffle grant, managing cookies and socket channels |
| `web/src/preview-origin/cookie-jar.ts` | Cookie storage model written from RFC 6265 section 5 |
| `web/src/preview-origin/sw-core.ts`, `sw-exchange.ts`, `sw.ts` | Preview-origin service worker |
| `web/src/preview-origin/relay.ts`, `bootstrap.ts`, `frame-page.ts`, `frame-entry.ts` | Relay page, cold-load page, and new-tab wrapper |
| `web/src/preview-origin/page-shim.ts`, `new-tab.ts` | Injected page script for cookies, service-worker guard, frame reports, and IDE-wrapped new tabs |
| `web/src/preview-origin/frame-watch.ts` | IDE watcher that tracks when a preview frame settles |
| `web/src/preview-origin/script-policy.ts` | Checks whether Content-Security-Policy headers admit the page script, using CSP Level 3 source matching |
| `web/src/preview-origin/host.ts`, `site/preview-worker.ts` | Static preview host |
| `web/src/preview-origin/workspace-identity.ts` | Stored workspace preview identity |
| `web/src/preview-html.ts` | Script insertion after the doctype, moved out of `web/src/sw-routing.ts` so both workers share it |

## Reuse of existing local code

- The page shim bundles `web/src/preview-websocket-client.ts`, the existing WebSocket client
  adapter in [Preview WebSocket request headers](preview-websocket-visible-headers.md). On a preview
  origin, it sends upgrades as structured fields instead of raw bytes and pings the IDE tab while
  the socket stays open.
- Exchange framing matches `web/src/preview-owner-client.ts`, using `id`, `open`, `input`,
  `output`, and `finish` over a `MessagePort` instead of the loopback host's WebSocket. The loopback
  host in [Local root previews](preview-origin-host.md) stays unchanged.

## Why these choices

- The cookie jar lives on the IDE side because browsers block service workers from reading or
  setting cookies, and `HttpOnly` values must never reach the untrusted preview origin.
- Script cookie writes travel as `fetch` requests so they share the request queue and stay ordered
  with later requests.
- WebSockets use a direct `MessagePort` from page to IDE so hot-reload sockets survive service
  worker restarts.
- The relay frame stays mounted across dev server restarts, and the IDE closes a port only after the
  worker confirms it. Dev servers report listening twice on startup. In Playwright's WebKit 27.2
  build, closing the first port a millisecond after sending it crashed the IDE page process in about
  one of every five loads.
- The worker adopts a port only after the IDE replies on it, so out-of-order delivery never picks a
  replaced listener's port.
- `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` is Vite's own variable for hosted setups and avoids a
  `server.allowedHosts` edit in every template.
- `?preview-origin` accepts only local domains under `localhost` or `.test`. Because the IDE gives
  each preview origin a channel to its dev server, URL parameters cannot pick public hosts.
- The IDE buffers each socket's upgrade response head in full and strips `Set-Cookie`. Any head over
  64 KiB fails the socket, because forwarding it unread could leak an `HttpOnly` cookie to the page.
- The service worker refuses top-level visits with the same `403` page as the static host. In a
  same-site layout, Chromium and Firefox let the worker control top-level tabs on the preview
  origin, which would otherwise serve the app and its cookies outside the IDE.
- Outside Chromium, a `MessagePort` has no close signal. The page pings the IDE tab, counting missed
  pings rather than elapsed time because browsers throttle hidden timers, and the IDE drops silent
  pages.
- A frame settles on its `load` event only after the server sends the final response for that
  navigation, following redirects. `load` also fires for blank, cold-load, and error pages, yet
  plain-text responses and script-blocked pages have no other signal. Because the IDE matches
  cross-origin frames only by URL, the owner tab broadcasts navigation answers for other tabs.
- The worker inserts the page script tag only when it passes every `Content-Security-Policy` header
  on the response. A blocked tag triggers a violation report, and the preview must not weaken an
  app's policy.
- For tabs the app opens, the script rewrites the link's `href` for the browser's click instead of
  calling `preventDefault` and `window.open`, so user activation, background tabs, and `rel` work
  as usual.
