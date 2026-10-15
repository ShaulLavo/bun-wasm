# ArrayBufferSink

`Bun.ArrayBufferSink` and the `bun` export now support owned byte writes, UTF-8 strings,
streaming flushes, typed-array output, restart, repeated end and idempotent close.
Option parsing and closed-sink behavior follow Bun's Rust implementation. A getter that
closes the sink during `start()` produces the closed-sink error safely.

The GC-tuning capability is absent because the engines cannot provide that control.
Previously, its throwing function passed the upstream harness's capability check and
prevented six byte-content tests from running. The browser host also captures its original
GC callback before the harness replaces global `gc` with `Bun.gc`, preventing recursion.
Hosts without an exposed collector still cannot force collection.

## Measured result

Selection: `js/bun/util/arraybuffersink.test.ts`, `js/bun/spawn/spawn.test.ts` and
`js/web/streams/streams.test.js`. Each engine's baseline has zero observed passes,
three synthetic failures and three errors, all blocked by the missing sink import.

| Engine | Fully passing files before / after | Observed passes before / after | Observed failures after | Timeouts before / after |
| --- | ---: | ---: | ---: | ---: |
| QuickJS | 0 / 1 | 0 / 18 | 173 | 0 / 0 |
| Browser host | 0 / 1 | 0 / 17 | 174 | 0 / 0 |
| Wasm JSC | 0 / 1 | 0 / 19 | 172 | 0 / 0 |

The sink file fully passes on every engine with 13 passes and one ASAN-only skip. The
spawn file now collects 177 cases, with 5, 4 and 6 passes respectively. Its remaining
assertions cover broader subprocess behavior. The streams file next requires the missing
`Bun.readableStreamToArray` export. Newly collected failures are not lost passing tests.

A JSC spawn-only repeat with identical provenance has six passes. The `dispose keyword works`
case varies with child-process timing; an intermediate three-file JSC run had 18 observed passes.
The sink file has the same 13 passes and one skip in every measurement.

Both sides use identical pinned hoisted dependencies, Bun source `4ceda2c` plus exported
patch `0009`, loopback networking, one worker, a 15-second file deadline and a 2-second
initial test deadline. Browser provenance additionally records the changed host GC hook.
The local fixture covers ownership, lifecycle, callable construction and the guest GC wrapper.
It runs through all engines and the real Chromium/WebKit browser check.

## Reproduce

Build all engines and install the pinned dependencies using [the suite guide](README.md#reproduce).

```sh
source env.sh
scripts/bun-suite.sh --network loopback --jobs 1 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-array-buffer-sink-quickjs.json \
  js/bun/util/arraybuffersink.test.ts js/bun/spawn/spawn.test.ts js/web/streams/streams.test.js
```

Repeat with `--engine browser` and `--engine jsc`, using separate output paths. The local
check is `scripts/test.sh --no-build --engine <engine> array-buffer-sink test-preload`.
