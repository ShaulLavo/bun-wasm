# Web guest test ownership

The fixture-free `web` job runs the unit test glob in `web/tests/`. The seven
artifact-backed cases live in `web/guest-tests/` and have one blocking owner,
the existing `rust` job. They do not depend on optional files appearing in CI.

| Group | Cases | Required fixtures | Producer |
| --- | --- | --- | --- |
| QuickJS | memory growth with both buffer modes, slot table, Node compose | `dist/bun.wasm`, `dist/bun-tools.wasm` and both build receipts | Existing QuickJS build plus one tools build |
| Host engine | nine subprocess checks, Node compose | `dist/bun-browser.wasm`, `dist/bun-tools.wasm` and both build receipts | Existing source-cache browser guest, linked into `dist/`, plus the same tools build |
| JSC | Node compose | `dist/bun-jsc.wasm`, `dist/bun-tools.wasm` and both build receipts | Existing conditional JSC embedding producer plus the same tools build |

Run selected groups with `source env.sh` followed by
`bun scripts/test-web-guests.ts quickjs browser jsc`. Preparation rejects missing
artifacts or receipts, corrupted bytes, and different patched Bun or sysroot
identities before starting any tests. The source commit, source tree and verified
fixture hashes are printed to the gate log. The compose assertions still cover
restricted PATH workers, self-spawn/fork, real child lint rules and local package
installation. No tools stand-in, skip or retry is used.

The tools build uses the native job's existing Cargo target. Binaryen is installed
before it, and cache saves remain after all producers and consumers. The four
shared process-browser bundles and source-cache artifact consumer stay unchanged.
The fixture receipts and execution logs are uploaded for review.

`ci-changes.ts` selects the native owner for its existing native inputs and the
shared Node-host/test contracts. Shared runtime, tool, host and fixture changes
also select JSC. Engine-specific Rust files keep their own checks. Page, editor,
sandbox UI and documentation changes do not build engines. New shared host
imports need a matching selection rule and regression check.
