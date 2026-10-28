# Wasmi Core port

Published crate `wasmi_core` 0.46.0, upstream `crates/core` at
`50ac76771d631f642e8c4c61bf44c99546024461` in `wasmi-labs/wasmi`.
The two license files are copied from `third_party/wasmi` (same revision).

The local patch makes Vec-backed linear memory growth reserve exactly the new size.
See `docs/bun-patches/wasmi-core-exact-memory-growth.md` for the reason and the test.
