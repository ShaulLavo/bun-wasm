# Preview origins

Classification: original Bun consumer adapter. No upstream implementation is copied or adapted.
It consumes Waffle's exported root-preview relay and wire dispatcher (`PreviewRouter` in root
mode, `PreviewHostDispatcher`, `PreviewHostOpen`, `PreviewHostInput`, `PreviewHostOutput`) from
`@waffle-os/runtime` 0.0.148 unchanged. [Preview origins](../preview-origins.md) describes the
behavior.

## Original adapters

| File | Role |
| --- | --- |
| `web/src/preview-origin/protocol.ts` | Host name shape, origin id, configuration, and the validated message shapes of every hop |
| `web/src/preview-origin/root-previews.ts` | IDE page: one relay frame per origin, one port per listener generation, readiness |
| `web/src/preview-origin/port-session.ts` | IDE page: the port's handler, bound to one Waffle grant; cookies; socket channels |
| `web/src/preview-origin/cookie-jar.ts` | RFC 6265 section 5 storage model, written from the specification |
| `web/src/preview-origin/sw-core.ts`, `sw-exchange.ts`, `sw.ts` | The preview origin's service worker |
| `web/src/preview-origin/relay.ts`, `bootstrap.ts`, `frame-page.ts`, `frame-entry.ts` | The relay page, the cold-load page and the new-tab wrapper |
| `web/src/preview-origin/page-shim.ts`, `new-tab.ts` | Injected page script: cookies, service worker guard, frame reports, new tabs through the IDE's wrapper page |
| `web/src/preview-origin/frame-watch.ts` | IDE page: when the document in a preview frame has settled |
| `web/src/preview-origin/script-policy.ts` | Whether a response's Content-Security-Policy admits the page script, written from CSP Level 3 source matching |
| `web/src/preview-origin/host.ts`, `site/preview-worker.ts` | The static preview host |
| `web/src/preview-origin/workspace-identity.ts` | The workspace's stored preview identity |
| `web/src/preview-html.ts` | Script insertion after the doctype, moved out of `web/src/sw-routing.ts` so both workers share it |

## Reuse of existing local code

- The page shim bundles `web/src/preview-websocket-client.ts`, the existing adapter of the runtime's
  WebSocket client ([its record](preview-websocket-visible-headers.md)). On a preview origin that
  adapter sends the upgrade as structured fields instead of raw bytes, and pings the IDE tab while
  the socket is open.
- The exchange framing follows `web/src/preview-owner-client.ts` (ids, open, input, output,
  finish) over a `MessagePort` instead of the loopback host's WebSocket. The loopback host
  ([its record](preview-origin-host.md)) is unchanged.

## Why these choices

- The cookie jar is on the IDE side because no browser lets a service worker set or read cookies,
  and because HttpOnly values must not reach the untrusted preview origin.
- A script cookie write travels as a fetch so that it shares the request pipe and keeps its place
  among later requests.
- Sockets get their own port from the page to the IDE so that a hot-reload connection does not
  depend on the service worker staying alive.
- The relay frame stays mounted across dev server restarts, and a port is closed only after the
  worker answered on it. A dev server reports listening twice as it starts. WebKit (Playwright's
  27.2 build) ended the IDE page's process in about one load in five when the first port was closed
  a millisecond after it was sent.
- The worker uses a port only after the IDE answered on it, so the port of a replaced listener is
  never chosen, whichever of two ports arrives first.
- `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` is Vite's own variable for hosted environments. It
  avoids a `server.allowedHosts` edit in every template.
- The `?preview-origin` parameter names local domains only (`localhost`, `.test`). The IDE page
  sends each preview origin a port to its dev server, so a link must not be able to name a public one.
- A socket's upgrade response head is held until all of it arrived and `Set-Cookie` is removed. A
  head past 64 KiB fails the socket: forwarding it unread could carry an HttpOnly cookie to the page.
- A top-level visit is refused by the service worker with the static host's answer. In a same-site
  layout the worker also controls a tab on the preview origin in Chromium and Firefox, and would
  otherwise serve the app and its cookies outside the IDE.
- A socket port has no disconnect signal outside Chromium, so the page pings the IDE tab (it counts
  unanswered pings, because a hidden page's timers are throttled) and the IDE drops a silent page.
- A frame settles by its `load` event only once the server sent the final response of that frame's
  own navigation (its address, followed through redirects). That event also fires for the initial
  blank document, the cold-load page and error pages, and a plain-text document or one whose policy
  keeps the script out has no other way to say that it loaded. A cross-origin frame cannot be tied
  to a request more closely than by its address; the owner tab broadcasts its answers so that the
  other tabs follow the same rule.
- The page script's tag is written only when it passes every policy of the response. A blocked tag
  would raise a violation report, and widening an app's policy is not ours to do.
- Tabs the app opens are pointed at the IDE's wrapper page by rewriting the link for the browser's
  own click, not by `preventDefault` and a scripted open: user activation, background tabs and
  `rel` then behave as in any browser.
