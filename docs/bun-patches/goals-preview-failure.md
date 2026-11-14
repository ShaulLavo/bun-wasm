# Goals preview failure observations

Class **Host feature**, **original test adapter** in
`scripts/goals-matrix/preview-failure.ts`, `transport.ts`, `scoped-transport.ts`
and `execute.ts`. No upstream implementation is copied or adapted, so there is
no upstream path or revision.

The Playwright transport attaches preview listeners before navigation. It keeps
at most 32 page errors, console errors, failed requests and HTTP error response
records, with bounded text. It serializes these records only when a cell fails.
URL and DOM readiness are read within 250 ms of the existing two-second failure
observation budget. A failed DOM read retains the already observed events.
Closing or replacing the preview, or closing the transport, detaches listeners
and clears the retained records. Success behavior, templates, assertions and
phase deadlines are unchanged.

The browser control owned by `checks/web-browser-goals-preview-failure.json`
uses real preview navigation, client exceptions and failed requests, and checks
listener release through the maintained transport.
