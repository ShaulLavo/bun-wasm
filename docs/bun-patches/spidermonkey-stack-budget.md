# SpiderMonkey host stack quota

## Classification

`crates/bunwasm-spidermonkey/cpp/stack-budget.h` is an original adapter. It
configures Mozilla's `JS_SetNativeStackQuota` in the production engine and the
standalone smoke. It targets `js/public/Stack.h` and `js/src/jsapi.cpp` at
Mozilla revision `a5df22d986d4b626f771b4f8885241941601c35c`.

## Changes and reasons

Read `BUN_WASM_STACK_KIB` once when initializing the context. A positive decimal
value selects the quota, clamped to 7 MiB and to the member's available stack.
Missing, zero and malformed values retain the available-stack default. Both
embeds keep 64 KiB between their largest quota and the bottom of the member's
shadow stack. The standalone smoke verifies the installed native stack limits.

The host call stack is separate from this shadow stack. Selecting a quota is
safe only after measuring every recursive path on the host that will use it.

## Upstream reservations

The WASI embed patch changes `js/public/friend/StackLimits.h`,
`js/src/vm/Interpreter.cpp` and `js/src/vm/PortableBaselineInterpret.cpp` at
the same revision. This is a port change. Address-escaped, uninitialized local
arrays reserve shadow bytes until the enclosing function returns. No bytes
are filled and no error-path bookkeeping is needed.

| Native reentry site | Tier | Reserved bytes | Covered calls |
| --- | --- | ---: | --- |
| `RunScript` | interp and PBL | 1536 | Native calls into scripts, including call/apply and self-hosted callbacks |
| `BUNWASM_HOLD_RECURSION_UNIT` in `ICInterpretOps` | PBL | 1536 | Scripted calls, getters, setters and bound targets reached through inline caches |

Remove a site's reservation when its calls stay inside the interpreter loop.
These sizes are calibration candidates until the small-stack browser sweep
and framework probes pass.
