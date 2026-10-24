# Changes to Bun and other upstream source

This ledger covers the Bun patch series, local changes to vendored dependencies, and copied or adapted upstream source outside vendor directories at this revision. Bun is pinned to `9510e74152073d850a18758ca41114d8f214ffa6` by `scripts/sync-bun.sh`. WebKit is Bun's fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`, pinned in `jsc/common.sh`.

Copied implementations include translations into another language and fragments retained inside otherwise original files. Generated upstream bundles and copied data tables are also listed. Directory names do not determine provenance.

Original adapters that call upstream APIs, implement the same public contract, or reproduce observed output without retaining an upstream implementation are bun-wasm source. They do not get a fork entry merely for being inspired by Bun or Node. Mixed files below identify the adapted portions separately from original host code.

Each row has one class. A file with independent changes has separate rows.

- **Port** means the change is required by wasm32, WASI, or the browser. Missing support for this new target is not a Bun bug.
- **Host feature** means bun-wasm adds a hook or behavior for its host.
- **Upstream bug** means the original code is incorrect independently of the new host. This includes incorrect 32-bit algorithms even when the distributed native Bun binary cannot reach them.
