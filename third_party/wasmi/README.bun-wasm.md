# Wasmi port

Published crate `wasmi` 0.46.0, upstream `crates/wasmi` at
`50ac76771d631f642e8c4c61bf44c99546024461` in `wasmi-labs/wasmi`.
The two license files are copied from that revision. The crate archive omits them.

The local patch exposes memory-handle equality and a per-memory successful-growth
counter. Both public and wasm-initiated growth increment it, including zero-page
growth. Failed growth leaves it unchanged. The translator and executor retain
zero-page growth operations so the JavaScript API can detach the old buffer.

See `docs/bun-patches.md` in the repository root for the changed-source inventory.
Other files match the published crate; `.cargo-ok` is omitted as local cache state.
