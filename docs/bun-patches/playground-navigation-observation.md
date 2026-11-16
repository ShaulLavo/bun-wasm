# Playground navigation observations

Classification: original local test and host adapter. No upstream implementation is copied or patched.

The navigation helpers under `web/tests/` and `web/navigation-server-log.ts` record browser requests separately from the local static host's correlated journal. `web/serve.ts` enables it only when a test selects its output path. The QuickJS stack driver owns that file within its temporary session.

Each navigation receives a unique query identity. Independent diagnostic requests remove it. A matching listening record qualifies the journal; missing, malformed or ambiguous evidence cannot establish that an original request failed to arrive. A returned `Response` records construction, not delivery to the socket or browser. Browser commit and completion remain separate observations.

Controls retain original failure objects, use acknowledged handler holds rather than speed thresholds, and close owned servers and browsers. This instrumentation does not identify a historical WebKit cause or claim a repair.
