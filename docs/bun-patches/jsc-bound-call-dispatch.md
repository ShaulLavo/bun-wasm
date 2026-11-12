# JSC bound function calls inside the interpreter loop

Files `runtime/VM.cpp`, `bytecode/BytecodeList.rb`, `llint/LLIntSlowPaths.h`,
`llint/LLIntSlowPaths.cpp`, `llint/LowLevelInterpreter.asm` and
`llint/LowLevelInterpreter64.asm` under `Source/JavaScriptCore`, in the last six sections of
`jsc/webkit-wasi.patch`, Bun's WebKit fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.
Class **Port**.

## The problem

Without the JIT, the call entry of every native function, `bind`'s result included, is
`llint_native_call_trampoline`. A bound function called from bytecode therefore ran
`boundThisNoArgsFunctionCall` in C++, which copied the arguments and called the target through
`JSC::call`, which entered the interpreter again: a new `CLoop::execute` on the host stack per
call, the same cost a getter had before [getter dispatch](jsc-getter-dispatch.md).

Babel's code printer pays that once per nesting level. `print` hands
`printMethod.bind(this, node, parent)` to `exactSource`, which calls it. The real
`@babel/generator` 7.29.14 printed 30 nested JSX elements at 192 KiB and 146 at 800 KiB,
then threw `RangeError`. The same printer with `bind` replaced by a closure printed 2,048,
the deepest tried. Every Babel-based framework build (SolidStart, React Router, TanStack
Start) runs this printer.

## The change

The executable of a bound function whose target is a `JSFunction` (the one that carries
`BoundFunctionCallIntrinsic`) gets its own call entry, `llint_bound_function_call_trampoline`.
Every bytecode call route jumps to the callee executable's entry, so first, linked,
polymorphic, closure, spread and tail calls all reach it. Construction keeps the native
construct entry, and C++ callers (`map`, `sort`, `JSON.stringify` replacers, bound getters)
keep calling the C++ function directly. The slow executable, used when the target is a
callable that is not a `JSFunction` (a Proxy, an internal function), is unchanged.

Only the WASI C loop does this. The C++ is under `ENABLE(C_LOOP) && OS(WASI)` and the
assembly under `C_LOOP and WASI`, the setting [getter dispatch](jsc-getter-dispatch.md)
added. `BytecodeList.rb` declares helpers for every build, so the entry is defined
everywhere and is `crash()` outside the WASI C loop, as the WebAssembly helpers are when
WebAssembly is off. It is appended at the end of `NativeHelpers`; no bytecode is added or
renumbered.

### The entry

The trampoline links the bound function's frame exactly as `nativeCallTrampoline` does:
prologue, a null code block, the VM's top call frame, the return address. It also clears the
frame's call site word, as upstream's JIT thunk for this intrinsic does. Then it calls
`llint_set_up_bound_function_call` with the bound frame. The C call publishes the bound
frame as the frame stack's pointer.

The helper returns two words, and the trampoline tests the exception signal before using
either:

| Outcome | First word | Second word |
| --- | --- | --- |
| Threw | `returnToThrow(vm)` | `exceptionSignal()`, all ones |
| Call | the target's entry point | the stack pointer for the target's frame |

On a throw, the trampoline reloads the VM from the bound callee, makes the bound frame the
top call frame and jumps to the throw trampoline, which is what the native trampoline does
when its C++ function threw. Otherwise it sets the stack pointer and calls the target with
`cloopCallJSFunction`, which returns to the new label 44. The target's epilogue leaves the
bound frame in `cfr` and the stack pointer at the target's own frame, a state the native
trampoline never has. The entry resets the stack pointer to `cfr` before its own epilogue.
It cannot use `restoreStackPointerAfterCall`, which reads the frame's code block, null here.

The bound frame stays on the frame stack between its caller and the target, a native frame
with no code block and a hidden callee. That is the layout upstream's JIT thunk for
`BoundFunctionCallIntrinsic` produces, so stack traces, `Error.stack`, unwinding and
`finally` see what they see there: the bound frame is skipped and a throw in the target
reaches the caller's handler.

### The helper

The bound frame has no code block, so the VM comes from the bound callee and the realm from
the target. The helper checks before forming a pointer to the new frame or writing anything:

- the bound and passed arguments, counted with overflow checking, against `maxArguments`,
  the limit `Interpreter::executeCall` enforces with `this` counted separately;
- the frame's aligned size against the bound frame's address, so it cannot wrap;
- `ensureJSStackCapacityFor` for the frame `calleeFrameForVarargs` places directly below
  the bound frame. It moves the frame stack's limit or commits more of its reservation and
  does not allocate on the heap.

A refusal throws the stack overflow `RangeError` of the target's realm. That is the realm
the C++ path used for both of its refusals (`executeCall`'s limit, then the VM entry's stack
check). Upstream's JIT thunk throws its own capacity failure in the bound function's realm
instead. The two differ only for a function bound across realms, which the guest cannot
create: it has no ShadowRealm and its `node:vm` contexts share one realm.

Then the frame is filled: caller link, null return address, null code block, argument count,
the target as callee, the bound `this`, the bound arguments, then the passed ones. Nothing
allocates in between, and every value copied is also held by the bound function (the bound
frame's callee) or by the bound frame's own arguments.

A target that is a host function, another bound function included, is entered through its
executable's call entry, as a bytecode call would be. A target with a body may be compiled
first, by `firstCallToJSFunction`, which also stores the code block and picks the arity
entry. The finished frame is published as the frame stack's pointer while it runs, for the
reason [getter dispatch](jsc-getter-dispatch.md#the-frame) gives, and the bound frame's
pointer is put back before any way out. A compile error, a class constructor called
without `new` and every other target failure are thrown by the target's own code, in its
realm, as before.

A tail call to a bound function still uses frame stack per bounce, because the bound frame
stays. It no longer uses host stack.

### Return label 44

`cloopCallJSFunction` returns to a label declared in `BytecodeList.rb`'s
`CLoopReturnHelpers`. The trampoline adds one, `llint_cloop_did_return_from_js_44`,
appended after [getter dispatch](jsc-getter-dispatch.md)'s 38 to 43.

## What still enters the interpreter again

A bound function called from C++, a bound function used as a getter, `new` on a bound
function, and a function bound to a callable that is not a `JSFunction`.

## Measurements

November 12, 2026, native launcher, split JSC. Both pairs use the READY core `13b54255…` and
launcher `37982e24…`. The baseline side `3eb741c2…` is main at `e12e307e`; the candidate side
`43423a8b…` is main plus this change.

| At 192 KiB | Before | After |
| --- | ---: | ---: |
| Real `@babel/generator` 7.29.14, nested JSX that prints | 30 | 2,048, the deepest tried |
| The same, nested calls | 31 | 2,048 |
| At 800 KiB, nested JSX | 146 | 2,048 |

`CLoop::execute` has one more call (684, was 683) and holds 4,896 guarded bytes at every
call, with 293 wasm parameters and locals, before and after.

## Tests

- `tests/fixtures/bound-call-dispatch` runs on all three engines, with output from native
  Bun: `this` and argument order with none, one, three and five bound arguments, strict and
  sloppy targets with primitive and undefined `this`, arity shortage, `arguments`,
  `new.target`, `length` and `name`, thousands of passed arguments, nested binds, native
  targets, `new` on a bound class, a class target called without `new`, throws with `finally`
  and the stack, first, linked, closure, polymorphic, spread, `apply` and tail calls,
  callbacks, comparators and replacers from C++, a bound getter, first calls under
  allocation, a caller with many locals, unbounded recursion and recovery, a call refused
  for its arguments before the target runs, Babel's printer cycle and an async target.
- `scripts/jsc-embedding.ts` runs that fixture on the matched JSC pair at 192 KiB on a 1 MiB
  host stack, with the printer cycle 2,000 levels deep and a caller with 33,000 locals.
- `scripts/jsc-embedding.test.ts` checks the patch's shape: the entry's order of steps, no
  `restoreStackPointerAfterCall`, the helper's refusals before writes and the published
  frame put back before the exception is read.
- `tests/stack-depth.js` gained `boundcall`, a function recursing through a bound copy of
  itself with two bound arguments. It joins every launcher and browser sweep.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, bound calls in the loop](#jsc-bound-function-calls-inside-the-interpreter-loop) | Port | Call the target of a bound function from the running C loop when bytecode calls it. |
| `tests/fixtures/bound-call-dispatch`, the printer cycle | Adapted upstream implementation | `Printer.print` and `exactSource` from `@babel/generator` 7.29.14 `lib/printer.js` (MIT), reduced to the bound callback and its recursion. |
| `tests/fixtures/bound-call-dispatch`, the rest; `tests/stack-depth.js`, `boundcall` | Original adapter | Bound call semantics and depth through the guest entry point. |

[Ledger scope and pinned revisions](scope.md).
