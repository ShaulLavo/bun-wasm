# 005. Patch Bun minimally and record every upstream change

Status: accepted
Date: 2026-10-15

## Context

bun-wasm compiles Bun's own Rust crates for a target Bun does not support. Every patch that diverges from upstream makes the next Bun upgrade harder. The project also copies and adapts source from Bun, Node and WebKit outside the patched checkout, and each copy carries its own license and provenance.

## Decision

Patches to Bun are commits on the `wasm` branch of a pinned `vendor/bun` checkout, exported to `patches/bun/*.patch` by `scripts/export-patches.sh`. `scripts/sync-bun.sh` re-creates the checkout from the pin and the patch bytes. Patches stay minimal: add `target_os = "wasi"` arms and host hooks, and do not rewrite. Prefer Bun's own `src/js` modules through the builtin loader over writing new ones.

Every new or changed patch, copied file or adapted implementation gets its own classified Markdown record under [`docs/bun-patches/`](../bun-patches/) in the same change. The record contains a classified row and records the upstream path and revision, the local changes and the reasons. Original adapters are listed separately. Each row has one class: port, host feature or upstream bug.

## Alternatives considered

- **Rewrite the parts of Bun that do not fit wasm.** It diverges from upstream with every change and makes the next upgrade a merge of two codebases. The rule is to add `wasi` arms and hooks instead.

## Consequences

Upgrading Bun means rebasing a short patch series and checking each changed record. A change without its own provenance record is incomplete. The stable entrypoint is not a feature-edit target. The class column separates changes the target forces (ports), additions for this host (host features) and bugs in upstream code.
