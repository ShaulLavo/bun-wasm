# JSC getter calls inside the interpreter loop

Files `llint/LLIntSlowPaths.cpp`, `llint/LowLevelInterpreter.asm`,
`llint/LowLevelInterpreter64.asm`, `llint/LLIntOfflineAsmConfig.h` and
`bytecode/BytecodeList.rb` under `Source/JavaScriptCore` in `jsc/webkit-wasi.patch`, Bun's
WebKit fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. Class **Port**.

## The problem

JSC's C-loop interpreter runs plain JavaScript calls inside one `CLoop::execute` activation.
Originally the `get_by_id` slow path found a getter and called it from C++, which entered
the interpreter again. Each nested getter therefore starts a new `CLoop::execute` on the host
stack, about 2 KB there and 5.8 KB of guarded shadow stack ([Stack overflow in wasm](../stack-limits.md)).
At the browser budgets that allows 34 nested getters. Ajv 8.17.1's code generator reads
`node.names` and `super.names` recursively, two getters per nested `if`, and stopped after 16
levels at 192 KiB. Angular's schema registry nests about 64. No budget fixes this on Safari,
whose worker stack has room for about 45 interpreter activations.

## The change

When `object.name` (`op_get_by_id`) or `super.name` (`op_get_by_id_with_this`) or `object[key]` (`op_get_by_val`) finds an accessor
whose getter is a JavaScript function, the slow path does not call it. It builds the getter's
call frame on the interpreter's own frame stack and hands the entry point back to the running
loop, which calls it the way it calls any JavaScript function. A getter level then costs what a
plain call costs: no host frames and no guarded shadow stack. Nothing else about the read
changes, and no budget, reserve or guard moves.

Only the WASI C loop does this. The C++ is under `ENABLE(C_LOOP) && OS(WASI)` and the assembly
under `C_LOOP and WASI`; `WASI` is a new offlineasm setting defined from `OS(WASI)` in
`LLIntOfflineAsmConfig.h`. Every other build compiles the original code.

### The lookup

`getOrFindJavaScriptGetter` is `JSValue::get()` with one difference. It runs the same
`getPropertySlot`, including primitive prototype synthesis and the `get_by_id` diagnostics, and
checks for an exception straight after it. A missing property is `undefined`, and the slot is
never read when the lookup failed. If the slot is an accessor whose getter is a `JSFunction`
that is not a host function, the getter is returned to the caller uncalled. Everything else
goes through `slot.getValue()` as before: host and bound functions, callable proxies and other
non-`JSFunction` getters, custom accessors, and Proxy reads, whose traps and target getters run
during the lookup itself. For `super`, the lookup base stays the home object's prototype and
the receiver is `slot.thisValue()`.

`performLLIntGetByID` also serves `get_length`, the iterator checkpoints and `instanceof`. It
became a template with a default argument: those callers compile the code they had, and only
`op_get_by_id` instantiates the variant that returns a getter. Its inline-cache bookkeeping is
where it was. That code caches value slots only, so a getter handed back installs no cache and
no pointer to the getter or its result is kept.

### Three outcomes

The three slow paths keep the signature and the two-word result every slow path has. They end in
one of three ways, which `callGetterInLoop` (C++) produces and `callGetByIdSlowPath` (assembly)
reads:

| Outcome | First word | Second word |
| --- | --- | --- |
| Completed | the bytecode pointer | null |
| Threw | `returnToThrow(vm)` | `exceptionSignal()`, all ones |
| Call the getter | its entry point | the stack pointer for its frame |

The assembly tests the exception signal before it uses either word as a pointer. Call setup
(`setUpCall`) reports its own errors in the call convention, `(callToThrow(vm), nullptr)`,
which would read as "completed" here. `callGetterInLoop` turns that into "threw" before it
returns, and asserts that a returned call has a target and exactly the stack pointer of the
frame it built.

### The frame

The bytecode reserved no room for a getter's frame, so it is placed below everything the
caller's frame can use: `calleeFrameForVarargs` from `CallFrame::topOfFrame()`, with one
argument, aligned as a varargs frame is. `topOfFrame()` is never above the loop's stack pointer.
`ensureJSStackCapacityFor` runs before anything is written, and a refusal throws the usual
stack overflow `RangeError`. Then the frame is filled in: caller link, null return address,
null code block, an argument count of one, the getter as callee and the receiver as `this`. The
caller's bytecode position is already stored, by the assembly and by the slow path prologue.

`setUpCall` can compile the getter. A collection scans the frame stack from its published
pointer and zeroes what lies below it (`CLoopStack::sanitizeStack`), so a frame staged below
that pointer would not be protected. The finalizer also spills pointer-sized Wasm locals into
linear memory; that does not publish or protect the staged frame. Three things cover it.
Nothing allocates between the lookup and the finished frame. At this pin
`ScriptExecutable::prepareForExecutionImpl` defers collection for the whole compile
(`DeferGCForAWhile`). And without relying on that, the finished frame is published as the frame
stack's pointer while `setUpCall` runs, which keeps the getter and the receiver alive and the
frame intact; the caller's pointer is restored before any way out of the function. Because of
the upstream deferral no test can make a collection land in that window, so the publication
is checked by reading the hunk, not by a failing control.

Back in the loop, the getter is entered through its normal entry point, so arity checks, the
frame's own stack check, `op_enter` and debugger hooks run as for any call. When it returns,
the loop restores the caller's stack pointer and uses the existing `dispatchAfterRegularCall`:
it reloads the caller's position, stores the result, records the value profile and advances
once. A getter that throws unwinds like any callee; the caller's handler is found from the
stored position of the property read.

### Generated return labels

A C-loop call site returns to a label declared in `BytecodeList.rb`'s `CLoopReturnHelpers`
section. The three bytecodes expand once per operand width. Computed reads add three
continuations, bringing the declared and emitted set to 47. Full offlineasm generation assigns
the private site numbers, including existing getter, direct-eval and bound-call sites. Their
numbers can change. The generated definitions and references must agree in both profiles.
No bytecode is added or renumbered, and the bytecode cache format is unchanged.

### Computed keys

`getByVal` keeps the fast data read, numeric-index path and array profiling, negative-one miss,
receiver coercibility check and property-key coercion in their original order. Only the final
generic lookup may return an ordinary JavaScript getter uncalled. Numeric-index accessors,
host and bound getters, callable proxies, custom accessors and Proxy bases retain their native
paths. String index keys can use the loop route. Primitive receivers remain primitive until
the getter applies its strict or sloppy `this` conversion. The common frame staging, exception
protocol and profiled result dispatch above also serve computed reads.

## What still enters the interpreter again

Setters, numeric-index getters, `super[key]`, enumerator reads, getters reached from C++ (`JSON.stringify`, `Reflect.get`, spread),
Proxy traps, `toString` and `valueOf`, and bound, host and callable-proxy getters keep their
path. Their measured depths are unchanged with one exception: a Proxy `get` trap read as
`proxy.name` passes through the `get_by_id` slow path this change edits, whose frames came out
48 guarded bytes smaller, and it reaches one level more at 800 KiB (125, was 124).

## A latent risk this makes visible

`CLoop::execute` opens with a 4,816-byte allocation that is mostly one 8-byte result slot per
slow-path call site, of which one is live at a time. Those dead bytes are what make the guard
stop native reentry at a depth Safari's host stack can hold. A compiler or flag change that
merged the slots would let every reentry path go several times deeper with no source change
here. `scripts/jsc-cloop-frame.ts` now fails the JSC side producer if the function holds fewer
than 4,896 bytes at any call it makes, on any path, or has more wasm locals than measured plus
12% ([the interpreter frame floor](../stack-limits.md#the-interpreter-frame-floor)).

## Measurements

November 11, 2026, native launcher, on the split JSC pair from CI run 42856642549 (source tree
of `19dba71e`) and the same core with a side built from this change.

| At 192 KiB | Before | After |
| --- | ---: | ---: |
| `object.name` getters | 34 | 39,930, then the frame stack's own `RangeError` |
| Reduced Ajv names walk (`ajvnames`) | 16 | completes at 4,096, the deepest tried |
| Real Ajv 8.17.1 names walk (`ajv`) | 16 | completes at 4,096, the deepest tried |
| `object[key]` getters (`computedgetter`) | 35 | 35 |
| Proxy `get` trap | 29 | 29 |
| `toString` reentry | 31 | 31 |

The whole sweep at 192, 208 and 800 KiB is in [Stack overflow in wasm](../stack-limits.md#getters-called-in-the-loop):
of 147 path results, the getter and Ajv rows changed as intended, the Proxy read gained one
level at 800 KiB, and 140 are identical.

`CLoop::execute` holds 4,896 guarded bytes at each of its 683 calls and has 293 wasm
parameters and locals, before and after. The static frames of the computed-getter and
`toString` cycles are identical. The Proxy read cycle lost one function to inlining: 6,560 to
6,512 guarded bytes and 429 to 419 wasm locals per level, and its depth at 192 KiB is still 29.
With the host stack cut to 256 and 512 KiB and the guard out of the way, wasmtime ran out
3 to 15% deeper on the three reentry paths after the change, so no path costs more host stack
per level there.

### Computed reads, November 13, 2026

The native launcher now completes 39,930 computed getter levels at 192, 208 and 800 KiB,
then catches the frame stack's `RangeError`. It also does so with 256 and 512 KiB host stacks
at the 192 KiB budget. Proxy-trap and `toString` capacities remain 29/31, 32/34 and 125/133
at those three budgets.

On Linux Chrome and WebKit with a 512 KiB host stack, 240 KiB guest budget and 2,048-byte
parser reserve, the original cold computed-getter control completes at 45 and catches
`RangeError` at 200000, with recovery after both. The original warm prefix measures 39,930
and a caught boundary in both browsers. WebKit's empty-handler Proxy and warm plain-JSON
traps remain separate units; these results do not claim that every stack path is safe.

The finalized split side holds 4,896 bytes at all 684 calls and has 293 value slots. The
finalized shared-group side holds at least 4,896 bytes (5,344 maximum), at 1,066 calls, and
has 52 value slots. Its inlining adds 16 calls relative to the earlier 1,050-call record.
The floor and 328-slot bound are unchanged.

## Tests

- `tests/fixtures/getter-dispatch` runs on all three engines: receivers, missing properties,
  throwing getters with catch, `finally`, stack and recovery, null and revoked-Proxy bases,
  primitive receivers in strict and sloppy getters, `super` in classes and object literals,
  host, bound, proxied, arrow, class and generator getters, a getter that declares parameters,
  Proxy targets, one read site across data, accessor and prototype changes, a self-replacing
  getter, nested returns, a hot site, callers with many live locals, first calls under
  allocation and near the stack limit, unbounded recursion, and the reduced Ajv walk. Each
  static read has a computed-key twin. Computed reads also cover key coercion order and
  failure, symbol and index keys, typed-array bounds, destination aliases, mixed data/accessor
  sites, fresh compilation under allocation, and value/failure/recovery at each operand width.
- `scripts/jsc-embedding.ts` runs that fixture on the matched JSC pair at 192 KiB on a 1 MiB
  host stack, with the Ajv walk 2,000 levels deep and a caller with 33,000 locals, which needs
  the widest operand form. `scripts/jsc-getter-continuations.ts source` emits the same
  generated functions for the JSC shell. Its `bytecode` command checks the actual read
  instruction, including the `*` and `**` width markers, rather than counting locals. The
  measured destinations are loc13, loc2005 and loc33005 for narrow, wide16 and wide32.
- `scripts/build-jsc.sh` checks all generated continuation declarations, references and
  definitions in each profile. The checker derives operand offsets and instruction length
  from the actual BytecodeList, checks all getter widths, direct eval and bound returns, and
  rejects wrong destination/profile operands and missing stack restoration in the real output.
- `tests/stack-depth.js` gained `computedgetter`, `ajvnames` and, for an installed package,
  `ajv`. The first two join every launcher and browser sweep.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, getter calls in the loop](#jsc-getter-calls-inside-the-interpreter-loop) | Port | Call JavaScript getters found by `op_get_by_id`, `op_get_by_id_with_this` and the generic `op_get_by_val` lookup from the running C loop. |
| `tests/stack-depth.js`, `ajvnames`; `tests/fixtures/getter-dispatch`, the names walk | Adapted upstream implementation | The recursion of `Node`, `ParentNode`, `BlockNode` and `If` `names` getters from Ajv 8.17.1 `lib/compile/codegen/index.ts` (MIT), reduced to the getters and their counts. |
| `scripts/jsc-cloop-frame.ts`, `scripts/src/wasm-code.ts` | Original adapter | Read one function's instructions from a linked side and enforce the interpreter frame floor. |
| `scripts/jsc-getter-continuations.ts` | Original adapter | Validate full offlineasm continuations and actual computed-read bytecode widths. |
| `tests/fixtures/getter-dispatch`, the rest | Original adapter | Getter semantics through the guest entry point. |

[Ledger scope and pinned revisions](scope.md).
