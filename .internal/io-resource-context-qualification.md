# Five-owner callback qualification on real guests

`tests/fixtures/io-resource-context` checks the callback frames PR 470 gave fs.watch, child IPC,
spawn, stdin and Bun.serve, on real guest engines. `scripts/io-resource-context.ts` runs it against
artifacts named on its command line and writes one `result.json`. It never selects `dist/` and
never builds.

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
# QuickJS and JSC: the selected launcher, the selected guest, and its side beside it.
bun scripts/io-resource-context.ts --surface native --engine quickjs \
  --guest $UNIT/dist/bun.wasm --launcher $UNIT/launcher/bun-wasm \
  --shell $UNIT/dist/bash-web-shell.wasm --env-utility $UNIT/dist/bash-web-env.wasm \
  --out $OUT/quickjs --qualify $HEAD $TREE
bun scripts/io-resource-context.ts --surface native --engine jsc --guest $UNIT/dist/bun-jsc.wasm ... --out $OUT/jsc --qualify $HEAD $TREE

# Browser: the selected web root in a real Chromium worker. TMPDIR must be 48 bytes or fewer.
TMPDIR=$SHORT bun scripts/io-resource-context.ts --surface chromium --web-root $UNIT/web --out $OUT/chromium --qualify $HEAD $TREE

# Controls, never qualification: Node-hosted Browser guest, and native Bun as a comparator.
bun scripts/io-resource-context.ts --surface node-host --guest PATH --context hooks --out DIR
bun scripts/io-resource-context.ts --surface host-bun --out DIR
```

These commands are prepared source-check routes, not execution approval. `--qualify HEAD TREE`
checks original native guest/side/launcher receipts against that source, but full input admission is
still pending the actual controller handoff. `qualification` stays false until that integration.
For Chromium, required selected Browser response bodies are awaited, including `.wasm.gz`, and
both response and decompressed identities are retained. An unrelated loaded Wasm cannot arm the
Browser observation. Matching the actual registry, source and full profiles remains an integration
gate. `scripts/test.sh` runs without `--qualify` for its selected engine.

The future handoff must validate registry-derived modes before setup: executable payloads 0555,
other files 0444, directories 0555. Never chmod sealed inputs or accept historical modes through
a compatibility branch. Unit 6 remains immutable and is not this fixture's executable input.

Native Bun 1.4.4 passes 17 of 22 rows. The five others are measured native differences the
runtime keeps on purpose: caller close and abort, caller IPC disconnect, the onExit receiver and
its order, and a throwing watch listener.
