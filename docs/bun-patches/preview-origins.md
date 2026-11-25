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
| `web/src/preview-origin/page-shim.ts` | Injected page script: cookies, service worker guard, frame reports |
| `web/src/preview-origin/host.ts`, `site/preview-worker.ts` | The static preview host |
| `web/src/preview-origin/workspace-identity.ts` | The workspace's stored preview identity |
| `web/src/preview-html.ts` | Script insertion after the doctype, moved out of `web/src/sw-routing.ts` so both workers share it |

## Reuse of existing local code

- The page shim bundles `web/src/preview-websocket-client.ts`, the existing adapter of the runtime's
  WebSocket client ([its record](preview-websocket-visible-headers.md)). On a preview origin that
  adapter sends the upgrade as structured fields instead of raw bytes.
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
- The relay frame stays mounted across dev server restarts. Removing it while its service worker
  was still installing left WebKit without a worker for the next listener.
- `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` is Vite's own variable for hosted environments. It
  avoids a `server.allowedHosts` edit in every template.
