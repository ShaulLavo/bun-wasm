# Ordinary JSC delivery adapters

These are original repository adapters. They copy no upstream implementation and
have no upstream source path or revision. Bun and WebKit revisions stay in the
original receipts and their existing patch records.

| Source | Class | Change and reason |
| --- | --- | --- |
| `scripts/ci-ordinary-jsc-program.ts` | Original adapter | Verify the existing private split pair and its core, side, composed-build, and embedding receipts, then retain the original bytes for consumers. Record composing source and cached component origins separately. |
| `scripts/ci-program-delivery.ts` | Original adapter | Write verified raw program files and delivery metadata into a new directory, shared by JSC and Browser exports. Remove only that directory on a failed write. |
| `scripts/jsc-embedding.ts` | Original adapter | Share the existing archive path list with the delivery verifier so embedding identity cannot diverge from the normal writer. The receipt format and blocking checks stay unchanged. |
| `.github/workflows/ci.yml` | Original adapter | Export only selected ordinary JSC after its existing embedding and native fixture gates. Upload the complete directory without compiling another guest. |

The verifier uses the existing program, profile, artifact identity and receipt
validators. The core must define one private memory capped at 16,384 pages, or
1 GiB. The side imports private memory. Delivery metadata records the maintained
iPhone host setting `BUN_WASM_STACK_KIB=192`; this native recursion budget does
not change the core's linker stack. The embedding receipt is checked against the
composed build's source, input stamp, archives, and both program files.

An imported side memory may omit its maximum. The in-memory delivery description
omits that property too, so strict verification matches the JSON representation
written to disk without inventing a side limit or changing the original receipt.

All four receipts accompany the raw pair unchanged. The core receipt covers the
untagged prefix, which must reproduce the supplied core with exactly its JSC tag.
The separate side receipt must equal the origin retained by the composed build.
No cached component acquires a new source label during export. The normal job's
successful gates establish validation; exporting a directory alone does not
claim that a producer run succeeded.
