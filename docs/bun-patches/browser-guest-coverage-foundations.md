# Browser guest coverage foundations

Classification: original adapter. No upstream implementation is copied or patched.

The catalogue, selector, selected runtime-input checks and child recorder under
`scripts/browser-guest-*.ts` adapt the existing local browser drivers to explicit
owner and engine selections. They target this repository at
`b851ed101a6d0b2aa1ae36e0f6d9a0908853ff37`.

The catalogue and TSV fixture preserve the forty-four tuple identities recorded
in the source audit on November 14, 2026. Control proofs remain separate from
those identities. The selector enumerates the drivers' actual local imports and
fixtures, with historical exact-file inputs supplied by verified Git snapshots.
It does not replace native producer selection. Shared side sources retain both
QuickJS and JSC, while the actual rquickjs-sys dependency selects QuickJS only.
The CI adapter schedules only selected new batches and preserves existing
Storage/default cells. The selected rows add their actual producer requirements
to the existing native decision, without making every Rust change require JSC.

The runtime-input helper checks selected served Wasm against the site's existing
engine identities, the required shell/env and installed base filenames, and every
required interruption entry. It checks the actual Sandbox Browser program too.
It needs no development receipt copies, source inventory or supplemental metadata.
Only the existing producer builds the interruption bundle, once. Consumers stage
selected raw programs privately without building or hashing the whole site.
Release and public deployment receipt libraries remain unchanged.

The execution adapter runs each child through `run-with-timeout.mts`. Its durable
ledger distinguishes planned, passed, failed and not-run rows, and records the
supervisor's descendant-drain receipt independently of functional evidence.
No Bun, Node or WebKit source is adapted by this change.

Shared Waffle libc inputs select every affected owner. Selected cores must have
the expected engine declaration, and paired companions must expose that engine's
initializer/RUN interface. Valid but mislabeled Wasm fails before browser launch.
Owned source-test fixtures use the configured temporary directory on both local
and GitHub-hosted machines.
