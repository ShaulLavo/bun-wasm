## Quality fixes in adapted source

The quality pass keeps Bun at `9510e74152073d850a18758ca41114d8f214ffa6`
and preserves the revisions already recorded above for Node and other ports.
It formats authored Rust under `crates/`, including the adapted bundler/dev-server
facades, compression, X.509 and installer code. Clippy fixes replace needless
borrows, explicit closures and manual loops with equivalent standard operations.
The Node zlib port and other mixed runtime factories lose unused bindings and
get explicit names for intentionally unused ABI arguments. No upstream patch or
generated bundle changes. These are maintenance changes to the existing ports,
not newly copied implementations or upstream bug claims.

The unchanged Bun incremental graph, packed map and serialized failure modules
remain upstream-owned even though authored facades include them by path. Local
attributes document that boundary instead of silencing all Rust. Host-only
unused ABI fields are identified separately from WASI callback code.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Quality fixes in adapted source](#quality-fixes-in-adapted-source) | Port | Mechanical formatting and lint fixes in the existing Bun/Node ports, without changing their upstream revision. |
