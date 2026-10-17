# Fake-timer compatibility measurement

The 12 files listed in [fake-timer-files.txt](fake-timer-files.txt) run unchanged,
with one worker, a 15-second file deadline, a 2-second default test deadline and
loopback-only networking.

| Engine | Fully passing files before | Fully passing files after | Observed passes before | Observed passes after | After failures | File timeouts |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | 0/12 | 12/12 | 3/42 | 42/42 | 0 | 0 |
| jsc | 0/12 | 12/12 | 3/42 | 42/42 | 0 | 0 |
| browser | 0/12 | 11/12 | 3/42 | 41/42 | 1 | 0 |

The remaining browser failure is the HTTP occupied-port error test in
`js/bun/test/test-timers.test.ts`. Its error event does not arrive before the
2-second test deadline. The timer controls and the other ten tests in that file pass.

The before run uses main `6e93c80c`; its artifacts contain the exact original
source bytes of all four JavaScript modules changed by this feature. The after
run includes the main process-service and browser-test integrations, PRs 33 and 43.
The vendored suite advanced from `cd95fa7a` to `5e0baa66` while the work was queued.
The selected files and their fake-timer helper sources are unchanged between those revisions.
This is a bounded compatibility comparison that includes those main integrations.

Reproduce against built artifacts, through the suite-class shared runner:

```sh
source env.sh
mapfile -t files < docs/bun-test-suite/fake-timer-files.txt
scripts/bun-suite.sh --engine quickjs --jobs 1 --timeout 15 --network loopback \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-timer-review/quickjs.json "${files[@]}"
```

Repeat with `--engine jsc` and `--engine browser`, using fresh output paths.
Raw results, per-file logs, hashes and the baseline source check are retained in
`/work/reports/bun-wasm-fake-timers/`. The coordinator owns their removal after review.

The review regressions run separately from the unchanged upstream selection:

```sh
scripts/test.sh --no-build --engine quickjs \
  fake-timers fake-timers-review fake-timers-runtime test-fake-watchdog
bun test web/tests/fake-timers-host.test.ts
```

Repeat the fixtures with `--engine jsc` and `--engine browser` through the heavy runner.
They check runtime callbacks and subprocess deadlines without advancing fake time, restoration
with callbacks pending, interval reentry and refresh, nextTick ordering, handled exceptions,
and repeated activation. The host tests check an armed wakeup across Date restoration and
the synchronous nextTick checkpoint. Browser native Promise jobs remain deferred until the
synchronous host drain returns.
