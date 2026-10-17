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
stack at the exit boundary. Test-runner completion has a separate
`test-complete` reason because it can intentionally finish with live handles.

Native app-matrix rows now retain the host `exit`, `signal`, `timedOut`,
`stoppedByHarness` and parsed `runtimeExits`. A successful server assertion ends
with harness cleanup, which is distinct from the guest exiting before it can
serve a response. A killed process can have a host signal without a guest exit
record. Install and build commands keep their host exit information too.

The classifier recognizes system error codes, Astro's message-only missing
exports and Vite's timestamped SSR errors. Page failures also retain pending request URLs, failed requests, HTTP errors and
browser console errors. Source revision is captured before execution, alongside
the runner source hashes. If no application diagnostic exists,
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

## Final 90-second replay

Source `e4b4ea0fcd5e608fbf9eb98ad56fc9a31d56100c`, based on main `6e93c80c`.
The six selected projects record 35 passing stages and 16 failures. All 2,709
registry requests replay from the frozen mirror, with zero misses or errors.
The runner reports cleanup complete. Raw reports and the exact scripts are in
`/work/reports/bun-wasm-silent-exits-2026-10-17/`.

| Check | QuickJS | JSC | Browser engine |
| --- | --- | --- | --- |
| Runtime fixtures | 205/205 | 205/205 | 205/205 |
| Vanilla install, dev/reload, build | 3/3 | 3/3 | 3/3 |
| Vue install, dev/reload, build | 3/3 | 3/3 | 3/3 |
| React install, dev/reload, build | 2/3 | 1/3 | 3/3 |
| SvelteKit dev render | Pass | Native module-loader fault | Exit 1 |
| SvelteKit build output | Missing | Deadline | Pass |

The full web gate passes. Built-site HMR passes all six Chromium/WebKit engine
runs. All 36 exit and parser checks pass. Generated watcher and scheduler code
match the current TypeScript sources in every engine build. The retained wasm hashes match
the matrix provenance.

The selected upstream test files are `js/first_party/ws/ws-upgrade-events.test.ts`,
`js/node/process/process-on.test.ts` and `js/node/process/process-nexttick.test.js`.
Each engine observes 27 tests, with no timeout. None of these three files is
fully passing before or after.

| Engine | Observed passes before | Observed passes after |
| --- | ---: | ---: |
| QuickJS | 10 | 13 |
| JSC | 8 | 11 |
| Browser | 10 | 13 |

The unchanged Node watcher assertion scripts `test-fs-watch-abort-signal.js`,
`test-fs-watch-recursive-update-file.js` and `test-fs-watch-ref-unref.js` change
from 0/3 to 3/3 fully passing files on every engine. They run as scripts and do
not add invented test counts. The baseline artifacts match the original replay
hashes. The temporary baseline worktree is removed after measurement.

### Remaining blockers

- React dev on QuickJS and JSC reaches a live server, then times out waiting for
  `@id//node_modules/.vite/deps/react.js` and `react-dom_client.js`. Both requests
  remain pending with no browser console or HTTP error at the 90-second bound.
  The host is then killed by the harness. A five-minute replay on the earlier
  source completes QuickJS dev/reload/build, while JSC receives HTTP 504
  `Outdated Optimize Dep` responses. A later 180-second replay on the scheduler
  source again completes QuickJS and browser; JSC still gets those 504 responses.
  The scheduler regressions prove fairness; they do not establish the cause of
  React's default-budget timeout or a startup-speed improvement.
- React build on JSC repeats the documented `JSLock::unlock` trap through
  `JSObjectSetProperty` and `engine_jsc::from_val`. QuickJS and browser builds pass.
- Astro exits 1 on every engine. QuickJS reports an unresolved circular
  `Fragment` binding in `astro/dist/runtime/server/index.js`. JSC and browser
  report missing `node:http2.Http2ServerResponse`.
- SvelteKit QuickJS renders its dev page, but build exits 0 after 179 modules and
  `rendering chunks`, with no `build/index.html`. The exit record has no
  referenced timers, message ports or I/O waiters. The final JSC dev run faults in
  `JSRopeString::resolveToBufferSlow<char16_t>` through `resolveModule` with an
  out-of-bounds Wasm access; earlier runs reached the deadline. JSC build still
  reaches its deadline after SSR bundle rendering. Browser dev repeatedly
  restarts config, loses the SSR transport, then exits 1 on an unhandled esbuild
  `Error during dependency optimization: The service was stopped`. Its exit
  record still has 128 referenced timers and two I/O waiters. Browser build passes.
- Vitest's default and thread pools both fail during module loading on every
  engine because `node:events` lacks `EventEmitterAsyncResource`. The failure
  precedes worker-pool execution.

The `networkHandles` counter is the referenced waiter count supplied by the
networking module. It also includes worker and subprocess I/O waiters registered
through that module.

## Scheduler starvation regression

A reduced script continuously queues an immediate while awaiting loopback HTTP.
Before the scheduler fix, QuickJS and JSC time out after four seconds with no
response. Browser and native Bun complete. A second script waits for a due timer
under that immediate load; all three wasm engines time out while native Bun
completes. These cases are separate from the framework timeout observations.

The ready immediate batch is now bounded. Recursively queued immediates wait
until the next batch, which gives due timers a turn. A shared TypeScript
scheduler steps I/O between callback turns. The two regressions and adjacent
timer/process fixtures pass on every engine, followed by all 205 runtime
fixtures per engine and the complete web/HMR gates. No Rust runtime behavior or
host ABI slot is added. The existing Rust comment is updated to describe the
scheduler return contract.
