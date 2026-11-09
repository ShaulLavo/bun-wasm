# Visible iPhone goals runner

Class **Host feature**, **original test adapter**. No upstream implementation is
copied. The adapter lives in `scripts/goals-matrix/iphone-*.ts`.

The matrix's SafariDriver tab is unsuitable for real XCTest input. The test adapter
uses an ordinary Safari owner page with an actual framework iframe. It injects a
small command observer into the test HTML through the existing preview-origin
binding, without changing the application bundles or guest bytes. The observer
retains the actual preview URL and document time origin across file edits.

The native click path arms a trusted-event observer on the actual enabled button,
finds its unique visible accessibility reference, and invokes the exact bound
`agent-device` command returned by T3 `device_open`. A successful command alone
cannot pass. The same button in the same document must receive a trusted click,
and its counter must change from zero to one. Other browser transports keep their
existing click implementation.

Each owner tab receives a unique test title for selective native cleanup. The Mac
wrapper checks availability, owns the normal Mac lock, refuses an existing
SafariDriver process, and records server and lock cleanup. Device command failure
stops further device interactions and the matrix, preserving the failed attempt.

The test server adds COEP and CORP only when absent on instrumented HTML so the
real preview can be framed by the isolated owner. Explicit policies are preserved.
Compressed or oversized HTML is rejected. These observation changes and native
command evidence remain test artifacts, separate from the original host inventory.
Install, rendering, interaction, hot reload, build, preview, and cleanup retain
their existing matrix deadlines.
