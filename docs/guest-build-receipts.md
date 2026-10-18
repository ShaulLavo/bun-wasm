# Guest build receipts

The four guest build entry points (`scripts/build.sh`, `scripts/build-bun-browser.sh`,
`scripts/build-bun-tools.sh`, and `scripts/build-bun-jsc.sh`) check imported Bun source
before compiling and write a sidecar beside the final optimized artifact:
`dist/<guest>.wasm.build.json`.

`scripts/sync-bun.sh --check` derives the expected Git tree from the pinned Bun
commit and the checked-in patch bytes, using a private index. A missing, dirty or
stale `vendor/bun` checkout fails the build; the check never synchronizes it.
Run `scripts/sync-bun.sh` explicitly to prepare the source.

The sidecar has one schema, represented by `GuestBuildReceipt` in
`scripts/guest-build-receipt.ts`:

```json
{
  "bunHead": "<40 lowercase hexadecimal digits>",
  "bunTree": "<40 lowercase hexadecimal digits>",
  "sysrootReceiptSha256": "<64 lowercase hexadecimal digits>",
  "artifactSha256": "<64 lowercase hexadecimal digits>",
  "artifactBytes": 123456
}
```

- `bunHead` and `bunTree` identify `vendor/bun`'s commit and source tree at build
  start. The tree must match the checked-in patch series.
- `sysrootReceiptSha256` hashes the exact bytes of
  `$BUN_WASM_SYSROOT/bun-wasm-sysroot.json`. That input receipt records the patched
  libc builder, patch, SDK, toolchain, environment and output identity. An unrelated
  Waffle package revision does not change those inputs.
- `artifactSha256` hashes the final, uncompressed Wasm bytes after optimization and
  JSC finalization, not Cargo's intermediate output. `artifactBytes` is their size.

The source must remain clean, and its HEAD/tree and the sysroot receipt must remain
unchanged until the sidecar is written. A failure emits no new receipt; any older
sidecar is invalid if its artifact hash no longer matches. Receipts are not upgraded
or inferred for existing artifacts: rebuild them through the normal entry point.

Consumers can import `verifyGuestBuildReceipt(bytes, receipt)` to validate the
schema and bind this sidecar to their exact artifact bytes. This is build provenance,
not a browser-test or publication attestation. The publication gate separately binds
uploaded bytes to the hashes exercised by the browsers; it should consume this same
sidecar rather than inventing a second build-identity format. Keep the sidecar with
its artifact until acceptance and publication are complete.
