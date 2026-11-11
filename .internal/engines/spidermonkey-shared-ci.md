# SpiderMonkey shared native CI

Status: Approved. November 10, 2026. Integration into J11 PR 599.

The existing `shared-sysroot` job owns the experimental SpiderMonkey library,
side and native fixture. It keeps its 30-minute deadline. The existing JSC
prebuild hands it the shared sysroot and atomics libc++; the Rust job hands it
the matching launcher. QuickJS produces the common core. SpiderMonkey verifies
that core's receipt against current shared-profile inputs and does not compile
another core. JSC and QuickJS owners, assertions and Browser checks stay intact.

Changes under `spidermonkey/`, both SM crates and the side/receipt scripts select
that blocking owner and the launcher. The library and side each have one
producer invocation. The consumer uses `test-checks.ts native --profile
shared-group`, including the unchanged shared-memory fixture. It fails on
missing selected output. For SM only, the discovered runner runs that same pair
once with `interp` and once with `pbl`. It sets the selector and trace flag in
both launcher and guest environments. QuickJS and JSC keep their one-run path.

Each SM run must return the original exact stdout and native exit status. Every
observed engine return must have positive interrupt polls. Interpreter returns
must have zero portable-baseline entries; PBL returns must have positive entries.
Missing, malformed or mismatched traces fail the gate. The last returning
member's trace must precede the final owner-settlement records, so a child's
trace cannot substitute for a missing final member observation. The final
physical-stop snapshot must have no members, reservations, retained members,
regions, pins, holds, watches, waiters or published entries, with no bypass.

The driver prints all stderr unchanged, including expected trap diagnostics.
It reads only the exact engine and accounting records for qualification. No
fixture or clock changes, extra producer invocation, Browser-host admission or
timing-based tier inference is involved.

The Mozilla fetch initializes its exact-pin sparse tree as a Git promisor
remote, so lazy source blobs work on fresh hosted runners. The recipe owns
patch application and readback. CI never resets or cleans the patched tree.
The source/native cache has an exact key over the recipe and overlay tree,
Rust inputs, compiler identities and actual shared sysroot. No prefix restore
can mix native generations. On a hit, the recipe still verifies patches,
configuration, library objects and staged headers. Only the recipe's disposable
`native/` staging directory is removed before repacking. Its source, objects and
original receipts remain in the cached generation.

The normal shared-native cache warms the SM side's Cargo target. Each selected
run relinks that side once, checks its actual exports and shared memory, and
records source and input identities before and after the build. The experimental program
receipt preserves the common core's original receipt rather than relabeling its
source. It also records the actual library, header and libc++ identities.
Unsupported native engines and ordinary split SM production remain refused.

The retained artifact contains the complete matched program directory, side
input snapshot and link map, and the library producer's receipt directory.
Because these paths have different roots, the upload preserves their relative
directory hierarchy. It includes `source.txt`, `spidermonkey-shared.json`, the
original common-core receipt and the library receipt, not just Wasm binaries.

Local orchestration tests use subprocess recorders. They do not stand in for
the real engine fixture or a cold hosted build. The qualified author head `8929c0ebe` is merged into this integration branch.
A real local driver run uses its retained side with the explicitly identified
older core and launcher. That private composition tests the driver, not current
producer provenance. The parent owns the first hosted cache miss, cache-hit log
check, independent review and PR merge.
