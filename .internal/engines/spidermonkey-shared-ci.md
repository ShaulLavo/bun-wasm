# SpiderMonkey shared CI

## Completed hosted Browser clocks, November 14

The bounded completion observation in run 43556231263 used normal shared inputs
and unchanged fixture assertions, 200 churn workers and 120,000-byte messages.
Interp main completed in 241,523.46 ms and PBL in 234,464.78 ms; both had exact
stdout, 32 retired owners, zero active groups and zero budget. Complete driver
spans were 280,805.01 ms and 273,249.10 ms. The diagnostic job deliberately
failed afterward and is not a normal qualification pass.

The normal SM-only main-page bound is 272 seconds and driver bound 316 seconds,
about 12.5 percent above the slower completed measurements. Driver setup remains
charged from the original monotonic start. Other pages retain 240 seconds, Oxc
retains 90 seconds, and QuickJS/JSC retain their 300-second drivers. The wrapper
keeps 330 seconds per tier. The SM sequential consumer gets 660 seconds, covering
two 316-second drivers plus 28 seconds for the measured profile/registration
controls and teardown. Other engine consumers retain 420 seconds. Both tiers,
all entries, failed-stop debt, output/accounting checks and cleanup remain
blocking. The temporary observation step is removed before normal CI.


Status: Approved. November 11, 2026. Native integration in J11 PR 599 and Browser integration in PR 600.

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

PR 600 adds a Browser consumer after the existing SpiderMonkey producer and native
consumer. It passes that same `program-spidermonkey/bun.wasm` to the existing
discovered `browser-guest --profile shared-group` owner. Chromium installation
and Web dependencies come from the earlier QuickJS Browser step. No extra core,
library, side or site producer is added. The selected wrapper registers separate
interpreter and portable-baseline tests, each with its original 330-second test
deadline and the driver's original 300-second process deadline. The owner keeps
its 420-second outer deadline. QuickJS and JSC retain one Browser execution each.

Each SpiderMonkey Browser test runs the actual production worker host, requires
the exact 8 MiB carve and stack Global identity, observes real tier counters,
checks ordinary recursion and depth-16 callback reentry recovery, then runs the
unchanged aggregate, parser-reserve ownership and failed-stop controls. Diagnostic
entry and control overrides are refused by the CI wrapper. Its scheduling tests
use synthetic metadata and subprocess recorders, never as runtime proof.

Kimi's existing six Browser/tier aggregates and two native aggregates remain bound
to their original source and retained artifacts. Integration adds focused source,
discovery and type checks and selected parser-reserve conflict controls. It does
not claim a new six-way qualification, current-head cold hosted production,
framework, Safari device or phone acceptance. The parent owns independent Browser
review and normal ready CI. PR 600 remains draft until that review passes.

The parser-reserve source merge exposed a first-search measurement difference on
portable baseline. Every parent measured assignment-compile capacity 334 on its
first search and 336 on an immediate second search before creating any Worker.
It stayed at 336 after the Worker. Capacity and ownership modes now run the whole
measurement loop once at zero depth before recording requested-depth searches.
Strict before/after and parent/child comparisons stay intact. The integrated
Chromium interpreter and PBL ownership controls both pass on the retained pair.

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
