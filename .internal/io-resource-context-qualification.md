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

The driver compares records with `rows.ts`. A turn-frame row (no resource owns the callback) must be
root on the hook path, and on native engines anything except the listed operation frames. Each row
ends `pass`, `missing`, `hung`, `error`, `exit`, `unarmed`, `late` or `mismatch`; anything but `pass`
fails the run. `unqualified` in the result lists the required rows no public guest route can observe.

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

`--qualify HEAD TREE` verifies the guest's original build receipt, its paired side and the launcher
receipt against that source. For Chromium it records the engine registry and the hash of every
`.wasm` and `.js` response the page loaded. Engines' closure gates bind those to the admitted
publication. `scripts/test.sh` runs the same driver without `--qualify` for its selected engine.

Native Bun 1.4.4 passes 17 of 22 rows. The five others are measured native differences the
runtime keeps on purpose: caller close and abort, caller IPC disconnect, the onExit receiver and
its order, and a throwing watch listener.
