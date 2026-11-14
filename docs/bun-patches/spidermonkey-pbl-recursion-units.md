# SpiderMonkey PBL reentrant calls hold a recursion unit

This upstream bug fix patches Mozilla revision
`a5df22d986d4b626f771b4f8885241941601c35c` through
`spidermonkey/spidermonkey-wasi.patch`. The change is guarded by
`__wasi__ && BUNWASM_EMBED`; other WASI builds keep the original behavior.

| Upstream path | Classification | Local change and reason |
| --- | --- | --- |
| `js/src/vm/PortableBaselineInterpret.cpp`, `ICInterpretOps` | Upstream bug | The `CallScriptedFunction`, `CallScriptedGetterResult`/`CallScriptedSetter` and `CallBoundScriptedFunction` IC ops call `PortableBaselineInterpret` again in C. Each now holds one `AutoCheckRecursionLimit` unit until the nested call returns (`BUNWASM_HOLD_RECURSION_UNIT`). |

## Why

WASI SpiderMonkey cannot read the host's call stack, so it counts recursion:
each live `AutoCheckRecursionLimit` holds one unit of a per-context counter, and
350 units is the limit. Interpreter frames entered from C++ hold two units while
they run (`RunScript` and `MaybeEnterInterpreterTrampoline`), and PBL frames
entered from C++ hold two (`RunScript` and `EnterJit`). PBL's own entry check in
`PortableBaselineInterpret` takes its unit in a block scope and releases it before
the frame runs. So when a PBL IC calls a getter, a setter, a bound function, or a
function with fewer arguments than parameters, the nested frame holds nothing, and
that recursion never reaches the limit. The bytecode stack bounds it at about
5,000 levels, while a cold Chromium worker holds about 730 nested PBL frames
(Firefox about 1,430, WebKit about 1,840). The browser's stack overflows first
and the worker dies instead of the program catching a `RangeError`.

Plain calls with enough arguments, constructors and array callbacks stay inside
the interpreter loop or reenter through C++, so they were already bounded and are
unchanged. Mozilla's own `wasi-pbl` build has the same gap.

## Effect

Measured with the standalone smoke probe in fresh dedicated workers (cold code) of
headless Chromium 156, Firefox 157 and WebKit 27.2, and under Wasmtime. Depth is the
number of levels entered before the caught `RangeError`.

| Path | PBL before | PBL after | Interpreter (unchanged) |
| --- | --- | ---: | ---: |
| Getter | browser stack overflow | 344 | 173, now 50,999 ([loop dispatch](spidermonkey-loop-dispatch.md)) |
| Setter | browser stack overflow | 344 | 173 |
| Bound function | browser stack overflow | 342 | 115 |
| Missing argument | browser stack overflow | 344 | 50,999 |
| Plain call, `call`, proxy, `toString` | 5,030, 115, 115, 172 | same | 50,999, 116 (now 50,998, [loop dispatch](spidermonkey-loop-dispatch.md)), 115, 115 |

After the change all 48 cases (three browsers, both tiers, eight paths) end in a
caught `RangeError` and the next evaluation succeeds. A PBL reentry costs about
1,360 bytes of host stack under Wasmtime, so 344 levels need about 470 KB; the
fixed build also catches every path at Wasmtime's default 512 KiB stack, where
main traps. Chromium, the tightest browser, keeps about twice the headroom.

On the native launcher (16 MiB host stack) PBL recursion through these paths now
stops at about 344 levels instead of about 5,000. That matches the interpreter
tier's limit for getters and other reentrant paths. Recursion with a missing
argument is the one case where the tiers differ, because the interpreter keeps
those calls in its loop.

Each counted call adds two out-of-line counter updates. A pinned, interleaved
guest workload of missing-argument, getter, setter and bound calls on PBL measured
2.029 s median CPU time against 2.027 s on main (10 runs each).

## Test

`crates/bunwasm-spidermonkey/examples/smoke.rs` recurses through getters, setters,
bound functions and missing-argument calls on both tiers and requires a caught
`RangeError` below 350 levels on every counted path, then evaluates again.
`scripts/spidermonkey-stack-quota.test.ts` expects its `ok counted reentrant
recursion` line. On main's library the PBL run fails that check.
