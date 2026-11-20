# SpiderMonkey PBL hands deep stacks to the C++ interpreter

This embed adaptation patches Mozilla revision
`a5df22d986d4b626f771b4f8885241941601c35c` through
`spidermonkey/spidermonkey-wasi.patch`, under `__wasi__ && BUNWASM_EMBED`. It is
unit 2 of the interpreter-loop work that
[loop dispatch](spidermonkey-loop-dispatch.md) started.

| Upstream path | Classification | Change and reason |
| --- | --- | --- |
| `js/public/friend/StackLimits.h`, `js/src/vm/JSContext.cpp` | Embed adaptation | `bunwasm::StackIsDeep(cx)` is true once a quarter of the byte quota is in use, or 128 recursion units are held. It reads the same stack base and quota the small-stack guard uses. |
| `js/src/jit/Jit.cpp`, `MaybeEnterJit` | Embed adaptation | On a deep stack a frame entered from C++ is not moved into PBL. It runs in the C++ interpreter, whose inline calls and getter frames use no host stack. |
| `js/src/vm/PortableBaselineInterpret.cpp`, `ICInterpretOps` | Embed adaptation | On a deep stack the scripted-function, getter and setter, and bound-function cache operations call through `js::Call`, or the construct route for a construction, instead of entering PBL again in C. |
| `js/src/vm/PortableBaselineInterpret.cpp`, call fast path | Embed adaptation | A call with fewer arguments than parameters pads them with `undefined` and stays in PBL's loop instead of missing the fast path. |
| `js/src/vm/Interpreter.cpp`, `RunScript` | Port change | The script-entry reservation is graded by depth on both tiers instead of by tier ([stack budget](spidermonkey-stack-budget.md)). |
| `js/src/proxy/Proxy.cpp` | Port change | The PBL proxy-trap reservation is removed, so the patch no longer changes this file; the deep script-entry size covers proxy recursion. |

## The hand-over

A hand-over builds the same frames as the file's own native-function call: a
`BaselineStub` frame holding the stub pointer, so the stub is traced, beneath a
native exit frame whose argument array holds the callee, `this`, the arguments
and `new.target`. Every value is on that traced array before anything can
allocate. The caller's JitScript is kept alive across the call, as the recursive
PBL call does.

- **Matching route.** A construction goes through `ConstructFromStack` with the
  original `new.target`, so `this` creation, derived classes and the
  primitive-return rule stay the engine's own. A getter is called with its
  receiver and no arguments, a setter with the receiver and the assigned value,
  and the setter's return value is discarded. A bound call passes the bound
  `this`, then the bound arguments, then the call's own; a total over
  `ARGS_LENGTH_MAX` takes the stub's ordinary failure path.
- **Tail position.** The route is taken only when the call is the stub's last
  operation, checked before anything happens. Otherwise the stub fails over to
  the next one, as before. After the call the operation returns its result
  without reading the stub again.
- **Outcomes.** A failure of any kind (a thrown value including falsy ones, an
  uncatchable error, a debugger forced return) leaves through the operation's
  existing error exit with the exception state the callee left. A completed or
  throwing call is never reported as a cache miss.
- **Holds.** The recursive PBL calls keep PR 774's unit hold
  ([PBL recursion units](spidermonkey-pbl-recursion-units.md)). The hand-over
  holds none of its own; `RunScript` takes its usual unit.

The scripted-function cache call stays, with its hold, reservation and
hand-over. After padding no successful plain call should reach it: the fast
path accepts everything that operation accepts. That is a source argument, not
a proof for every program, so deleting the site waits for a structural proof.

After the first crossing the chain is in the C++ interpreter. Calls and named
getters stay in its loop there. Setters, computed-key getters, bound functions
and `call`/`apply` still recurse natively in C++ until later units, bounded by
the counter and the byte quota. Code that runs while the stack is deep runs at
interpreter speed.

## Effect

Measured November 15, 2026; tables and method are in
[stack limits](../stack-limits.md#spidermonkey-pbl-on-deep-stacks).

- PBL getter, missing-argument, `call` and `apply` recursion and Ajv's getter
  walk pass 17,000 to 55,000 levels before a caught `RangeError`, where main
  stopped at 115 to 344. Setters, bound functions, computed getters and proxies
  still stop at the counter or the quota.
- In the guest at the 188 KiB WebKit budget, cold, every runtime shape of the
  small-stack sweep is caught on both tiers on the M1 Mac and on Linux under
  `ulimit -s 512`. The shapes that keep the native route are caught up to at
  least 218 KiB on the Mac and 237 KiB on Linux. On the Mac, main's engine
  trapped at 188 KiB on PBL `toString`, proxy and array-like `apply` and on
  interp computed getters. Default Chromium and Firefox catch every runtime shape
  on both tiers.
- Next's webpack hook and the guest's bootstrap load in the launcher at 184 and
  105 KiB on PBL, as on main.
- `js::Interpret`, `js::RunScript`, `ICInterpretOps` and both PBL loops keep
  main's shadow frames (432, 48, 80 and 432 bytes). The PBL loops have three more
  wasm locals each.
- PBL CPU time: 4 percent less at the top of the stack, because padded calls stay
  in PBL's loop, and 8 percent more for the same work under a deep stack, which
  now runs in the C++ interpreter.

## Original adapters and controls

`crates/bunwasm-spidermonkey/tests/loop-dispatch.cpp` gains PBL controls. With
`BUNWASM_INTERPRETER_CONTROLS`, PBL calls three test hooks: one refuses the call
fast path, so plain calls and constructions reach the call cache and its
hand-over; one runs inside each hand-over once its frames are in place, where
the controls force a shrinking GC; one counts scripted getter calls made by a
getter stub. `scripts/spidermonkey-loop-controls.ts` now compiles
`PortableBaselineInterpret.o` with the flag beside `Interpreter.o`. Release
builds contain none of the hooks.

For a call, a construction with a primitive-returning constructor, a derived
class construction, a getter, a setter and a bound call, the controls check the
result, receivers and argument order, a moving GC inside the hand-over, an
uncaught falsy throw, a caught token, an uncatchable error that skips `catch`
and `finally`, and caught exhaustion. Each run must cross a hand-over, and the
recursion-unit depth and interpreter frame count must return to their entry
values. A Debugger forces a return from the first frame a hand-over enters,
for the call, getter, setter and bound routes. A getter site specialised before
a deep excursion still calls through its stub afterwards, shallow code still
enters PBL, and the final host interruption lands under 300 getter levels that
crossed a hand-over.
