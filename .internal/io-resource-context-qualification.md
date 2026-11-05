# Five-owner callback qualification on real guests

`tests/fixtures/io-resource-context` checks the callback frames PR 470 gave fs.watch, child IPC,
spawn, stdin and Bun.serve, on real guest engines. `scripts/io-resource-context.ts` runs it against
the current controller's pinned handoff and writes one `result.json`. It never selects `dist/`
and never builds. Individual artifact paths remain source checks, not qualification.

## How it runs

The guest orchestrator (`index.ts`) starts each row in a fresh guest process (`row.ts <row>`). A row
registers its resource in a named AsyncLocalStorage frame with the public API, drives a real event,
and records the frame current in every callback. After registration the row enters an unrelated
ambient frame, so a callback that kept the turn's frame is distinguishable from one in its
resource's frame. The serve root row starts its server before that, at true root.

- Stdin rows read their own stdin. The orchestrator writes each input only after the row prints
  `READY` or `GATE`, so every byte arrives after the read it belongs to was started.
- IPC and spawn rows fork or spawn `payload.ts` through `process.execPath`.
- The blocked-send row stalls the child's message loop and counts as armed only if neither queued
  send callback ran by a checkpoint inside the stall.
- A row process must exit on its own. A referenced handle left behind makes the row `hung`.

The driver compares records with `rows.ts`. A turn-frame row must be root on the hook path. Native
frame exclusion is only a `limited` observation, not proof of exact turn preservation. Such a run
is `partial`; callback errors still fail. The result lists omitted implemented rows, limited native
rows and the public-API limits under `unqualified` separately.

Callbacks stream until natural process exit. The completion marker retains the boundary needed to
detect late callbacks. Duplicate reports, malformed fields, unexpected rows and wrong executable
routes refuse. Host deadlines cover native spawn and the entire Chromium setup/run/readback;
owned server and browser termination is awaited before cleanup is reported.

## Commands

Source `env.sh` first. Use fresh, task-owned output directories.

```sh
# QuickJS and JSC derive exact guests, sides, launcher and shell from the handoff.
bun scripts/io-resource-context.ts --surface native --engine quickjs \
  --handoff "$HANDOFF" --handoff-sha256 "$SHA" --out "$OUT/quickjs"
bun scripts/io-resource-context.ts --surface native --engine jsc \
  --handoff "$HANDOFF" --handoff-sha256 "$SHA" --out "$OUT/jsc"

# Browser: the selected web root in a real Chromium worker. TMPDIR must be 48 bytes or fewer.
TMPDIR="$SHORT" bun scripts/io-resource-context.ts --surface chromium \
  --handoff "$HANDOFF" --handoff-sha256 "$SHA" --out "$OUT/chromium"

# Controls, never qualification: Node-hosted Browser guest, and native Bun as a comparator.
bun scripts/io-resource-context.ts --surface node-host --guest PATH --context hooks --out DIR
bun scripts/io-resource-context.ts --surface host-bun --out DIR
```

These are prepared commands, not execution approval. The handoff must follow the current
`bun-wasm.c1-handoff/1` contract and independent byte intake. Old admission shapes and `--qualify`
are rejected. The adapter binds the clean selected source, tuple, registry member paths, output
roots, dependency trees and full split or default Browser receipts. Source-cache Browser and
minimal or shared-group QuickJS do not substitute. `scripts/test.sh` uses explicit source-check
paths for its selected engine, never the qualification route.

`FiveOwnerResult` and `buildFiveOwnerResult` in the driver define the output contract. `status`
is `pass`, `partial` or `fail`. Native turn exclusions produce `partial` and `qualification: false`,
even if every requested row finishes without a mismatch. A complete Chromium hook-path run can
qualify its 22 observed rows. The ten named public-API limits remain in every result. Exit zero
means either `pass` or `partial`, not full consumer acceptance. Subsets and controls cannot qualify.

The top-level `loaded` array uses the controller's exported `LoadedObservation` type. It contains
actual successful GET response bodies, including the page and worker assets. The body is decoded
for HTTP Content-Encoding. An explicitly fetched `.wasm.gz` with identity encoding remains raw
gzip in `loaded`; `payloadEvidence` separately retains its decompressed identity. All pending
body reads finish before context closure. `bindLoaded` checks the actual observations against
the admitted Web registry, and the selected default Browser payload must be observed.

Intake checks registry-derived exact modes before setup: executable payloads 0555, other files
0444, directories 0555. Delivery reads recheck member modes and every sealed ancestor before and
after the bytes are read. Chromium's dependency tree is rechecked immediately before launch.
The whole delivery and its pinned handoff and intake are checked again after teardown. Consumers
never chmod sealed inputs. Unit 6 remains immutable and is not an executable input to this driver.

Native Bun 1.4.4 passes 17 of 22 rows. The five others are measured native differences the
runtime keeps on purpose: caller close and abort, caller IPC disconnect, the onExit receiver and
its order, and a throwing watch listener.
