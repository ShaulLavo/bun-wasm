# Browser base programs

Original Bun consumer composition; no upstream implementation is copied.

The web and sandbox pages each own one Waffle Runtime. `BrowserPrograms` installs
Waffle's published base package once on that runtime and separately registers
bash-web's shell commands. Shell sessions borrow the runtime and do not install
base programs. A standalone Shell host owns its own installation; it does not
share Bun's application lifecycle.

Installation creates executable metadata only. Guests load on first execution,
through Waffle's public generic preview1 worker. The app uses the installation's
PATH directories. On final page exit the runtime stops processes before the app
releases its program installations. A failed install rolls back its own markers.

Bun preserves `new URL(..., import.meta.url)` rather than emitting WASM assets.
The browser build adapter keeps each installed family's source manifest intact,
anchors its relative URLs under the page's `programs/base/<package>/` directory,
and emits that family's packed WASM there. It does not fetch guests at startup or
use bash-web's retired program binaries.
