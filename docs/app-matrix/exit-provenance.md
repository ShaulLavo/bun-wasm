# Framework exits and Vite reloads

The 2026-10-17 replay labelled Vite, SvelteKit, Astro and Vitest failures as exits
without diagnostics. Their retained raw logs all contained the same first error:

```text
ENOENT: no such file or directory, open 'ws'
```

The classifier recognized `Error:` and engine error names, but omitted system
error codes. The Rust resolver returned the builtin id `ws`; the JavaScript
require dispatcher recognized only reserved prefixes, then tried to open `ws`
as a file. Dispatch now checks the builtin factory registry as well.

After that fix, Vite dev called `process.exit(0)` from `closeServerAndExit`.
The exit record showed one referenced timer and three immediates still queued.
The stdin adapter started reading when Vite attached an `end` listener. That
produced EOF and invoked Vite's shutdown callback. An `end` listener now observes
consumption without starting it. A `data` or `readable` listener, `resume()`, or
async iteration still starts reading.

SvelteKit dev next reached `fs.watch`. The runtime now supplies an original
polling watcher over the existing filesystem operations. Its timer owns process
liveness and closes through the same path for explicit close and abort. The
[adapter record](../bun-patches.md#portable-filesystem-watcher) states its limits.

## Exit records

Set `BUN_WASM_TRACE_EXIT=1` in the guest environment. The runtime writes one JSON
line beginning with `[bun-wasm:exit]` at explicit exits, unhandled errors and
loop completion. It includes `reason`, `code`, `stack` and a `loop` snapshot.
The snapshot contains referenced timers, immediates, ticks, pending I/O,
message-port references and network handles. Fatal errors use their original
stack. Explicit exits capture the caller stack. Loop completion captures the
stack at the exit boundary.

Native app-matrix rows now retain the host `exit`, `signal`, `timedOut`,
`stoppedByHarness` and parsed `runtimeExits`. A successful server assertion ends
with harness cleanup, which is distinct from the guest exiting before it can
serve a response. A killed process can have a host signal without a guest exit
record. Install and build commands keep their host exit information too.

The classifier recognizes system error codes, Astro's message-only missing
exports and Vite's timestamped SSR errors. If no application diagnostic exists,
it uses the recorded guest exit reason.

## Reload assertion

Each native Vite dev row first renders the pinned fixture, edits `src/main.js`,
observes a Vite WebSocket `update` or `full-reload` message and waits for the
changed text in the page. The source is restored in `finally`. React and Vue
fixtures use the same dependency versions and source forms as before this fix.
Screenshots preserve the updated DOM. This tests Vite's reload transport; the
fixtures do not install React Fast Refresh or Vue single-file-component plugins.

The first browser-engine replay passes all nine Vite install, dev/reload and
build stages. All registry requests came from the frozen mirror with zero
misses and errors. The reduced builtin, stdin and watcher fixtures fail on the
baseline and pass after the corresponding fixes.

## Reproduce

Run from an exclusive worktree with all three artifacts and a rebuilt native
launcher. Source `env.sh` and use private Cargo target directories. Run through
the shared heavy wrapper:

```sh
scripts/app-matrix.sh --apps=vite-vanilla,vite-react,vite-vue,sveltekit,astro,vitest \
  --engines=quickjs,jsc,browser --hosts=native --timeout=90 \
  --cache=/work/cache/bun-wasm-app-matrix \
  --launcher="$CARGO_TARGET_DIR/release/bun-wasm" --output=<fresh-directory>
```

`bun test scripts/exit-provenance.test.ts` checks fatal errors, rejected
promises, explicit exits and empty-loop completion on all built engines.
`bun test scripts/app-matrix/exit-provenance.test.ts` checks the retained
framework error forms and host/guest provenance separation.
