## Persistence provider quota fixture

Class **Test adapter**, adapted from Waffle's public provider test protocol.

Upstream is `ShaulLavo/waffle` at `c9cc518e12b42d302176c6d29b6111f6b4cfeb4d`,
published as 0.0.125. Reference paths are `tests/storage-quota-control.ts`,
`tests/page-runner/storage-worker.ts`, and `tests/storage-browser-runner.ts`.

`web/tests/persistence-quota.ts` forwards the provider's unnumbered `idleQuota`
requests and returns `idle-quota-result` success or error messages.
`persistence-quota-host.ts` adapts the reference Chromium CDP quota override and
initial 8 MiB allocation grant to Bun's existing persistence fixture.
Other browsers report quota control as unavailable, including the optional
native Safari runner, which has no CDP quota override. Host errors remain errors.
The provider package and its storage tests are unchanged.

`browser-persistence.ts` runs each exact registered provider label in a fresh
context, matching the reference runner's storage isolation. The full smoke run
asserts that executed, selected and registered inventories are equal. Existing
smoke deadlines, durability checks and package pins remain unchanged.

Original adapters, separate from that adaptation, are the native IndexedDB
positive and negative controls in `persistence-browser-worker.ts` and the
quota bridge regression in `scripts/persistence-quota.test.ts`. They require a
native quota rejection, a successful same-sized write after reset, and an error
reply from a detached CDP session.
