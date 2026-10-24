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
also select JSC. Engine-specific Rust and test files keep their own checks. Page, editor,
sandbox UI and documentation changes do not build engines. New shared host
imports need a matching selection rule and regression check.

The native v2 and v4 restore/save primary keys include the tools builder and
workflow. A builder-only edit changes both exact keys while retaining both
compatibility prefixes. A workflow edit changes the v2 compatibility fingerprint,
so it cannot reuse the old v2 target. The v4 compatibility prefix stays unchanged,
so a workflow-only producer edit can still restore compatible v4 dependencies.
Neither edit can exactly hit the pre-tools primary and suppress a fresh save.

The v4 fallback runs only when v2 has no matched key. A v2 prefix hit does not
restore or save v4. Tools always builds once in the native Cargo target, even on
an exact hit, never in either separate JSC directory. Both guest gates and receipt
preparation precede all four final saves. Default success gating prevents any
selected cache save after a failed guest gate. JSC prebuild validation and its
separate Cargo cache retain their existing identities and guards.

The native job overlaps only the single selected JSC C/C++ prebuild with its
sequential native gates and QuickJS fixtures. It starts after shared sysroot and
input preparation and private JSC cache restores. One Bash step owns the child
process group, its failure log and cleanup. Either branch failing blocks the join;
cancellation terminates and reaps the owned group and its descendants. The child
keeps JSC environment changes private. JSC Cargo and every later host/tools/guest
command wait for both branches to succeed. The prebuild log joins the always-run
receipt diagnostics. The four successful-only saves and their cache-key rules
remain unchanged; there is no early warming save or additional producer.
