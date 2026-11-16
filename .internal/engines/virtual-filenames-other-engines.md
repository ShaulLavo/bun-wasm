# Virtual filenames outside SpiderMonkey

Status: Approved, separate filename work. The frame-kind task changes no other
engine's filename metadata.

At source `0def0d913`, a private local QuickJS build and Browser build were run
with `virtual-filenames`, although its maintained manifest
`checks/native-spidermonkey-virtual-filenames.json` selects only SpiderMonkey.
Both failed. The four common stack controls passed on QuickJS. Browser passed
reentrant, mapped-once and predicates; the new string fixture initially assumed
installed-method descriptors for V8's native method, which the frame-kind PR
corrects separately.

Reproduce after building each engine locally, with the matching own launcher
and shell environment and runtime type/focused checks complete:

```sh
source env.sh
BUN_WASM_RUNTIME_CHECKED=1 scripts/test.sh --no-build --engine quickjs virtual-filenames
BUN_WASM_RUNTIME_CHECKED=1 scripts/test.sh --no-build --engine browser virtual-filenames
```

QuickJS reaches `tests/fixtures/virtual-filenames/index.ts:18` and returns stack
`[]` instead of `[{"file":"\u0000plugin-vue:export-helper","line":1}]`.
`crates/bunwasm-engine-quickjs/src/vm.rs:243` uses
`CString::new(filename).unwrap_or_default()`, replacing a NUL filename with an
empty C string. That is a concrete source candidate, not a completed diagnosis
or authorization to relabel frames. Preserve exact source-map keys when fixing
it; inspect module compilation too.

Browser reaches the same assertion with `[]` even for `ordinary.ts`, where the
expected frame is `[{"file":"ordinary.ts","line":1}]`. Trace the `node:vm`
Script execution and custom CallSite filename path before deciding its fix.
No last-green search, metadata change, expected-output edit, or baseline build
was performed. This observation does not establish when either behavior began.

Raw output, commands and private build source are recorded under
`/work/reports/wave-20261116/engines/sm-frame-kind-implementation/other-engine-proof.log`.
The task removes its build payloads after checks; a fresh lane builds its own.
Estimated follow-up is 20 to 40 agent minutes per engine for bounded diagnosis
and a minimal fix, before review and CI. These are estimates, not measured work.
