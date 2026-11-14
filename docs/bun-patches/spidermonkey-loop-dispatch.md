# SpiderMonkey getters, call and apply in the interpreter loop

This embed adaptation patches Mozilla revision
`a5df22d986d4b626f771b4f8885241941601c35c` through
`spidermonkey/spidermonkey-wasi.patch`, under `__wasi__ && BUNWASM_EMBED`.

| Upstream path | Classification | Change and reason |
| --- | --- | --- |
| `js/src/vm/Stack.h`, `Stack-inl.h`, `Stack.cpp`, `Activation.h` | Embed adaptation | Allocate a frame's callee, `this`, arguments and missing formal arguments with its interpreter frame (`pushOwnedInlineFrame`; the caller supplies a copy step that cannot GC). A frame flag selects cleanup from the caller's opcode. An explicit result mode permits replacement or preservation of the caller's value. The ordinary inline return tests the flag once and leaves owned frames to an out-of-line pop in `Stack.cpp`. |
| `js/src/vm/NativeObject.cpp`, `NativeObject.h` | Embed adaptation | A sibling lookup defers eligible scripted getters at the existing call site. The prototype walk, resolve hooks, data reads and exotic-object dispatch still use the ordinary lookup. |
| `js/src/vm/Interpreter.cpp`, `Interpreter.h` | Embed adaptation | `GetProp` and `GetPropSuper` publish the getter frame through an out-of-line helper, then use the ordinary inline entry, return and unwind paths. The value lookup shares upstream's primitive, length and conversion handling. Call opcodes whose callee is `Function.prototype.call` or `apply` run an eligible scripted target in the loop (below). |

`js::Interpret`'s frame is paid by every native reentry that remains, so the
change keeps it at main's size: 432 bytes of shadow stack and 48 Wasm locals. A
first version that put the owned-frame branch into the inlined return path grew
it to 464 bytes, and with it the residual proxy recursion on the 512 KiB WebKit
model fell from 86 to 77 levels. The owned pop, the frame push and
delazification therefore stay out of line. The deferred lookup keeps upstream's
call shape: one out-of-line entry like `js::GetProperty(Value)`, with the object
step inlined as upstream inlines it. A version that added a second out-of-line
step cost proxy recursion one more native frame per level (Chromium 482 to 438
levels). The `call` and `apply` decision is likewise one out-of-line function,
reached only from the call opcode's native-callee path.

## Getters

The getter must be interpreted, in the current realm, and callable without
construction. A realm observing native calls retains synchronous dispatch. A
proxy or exotic prototype also retains synchronous dispatch, including its
invariant checks. Computed getters, setters, `Reflect.get` and PBL cache calls
are unchanged.

The selected getter stays in the interpreter's mutable function root through
delazification. The receiver comes from the case's existing `lval` or `receiver`
root, never from the operand the generic lookup clears. Frame allocation cannot
GC. All owned argument slots are initialized before the frame is published.
The caller PC remains on the property opcode until success. Throws, debugger
hooks, finally blocks, generator suspension, async suspension and failed
prologues use upstream's existing paths. The new frame holds no recursion unit
and remains subject to the interpreter's 50,000-frame limit.

## `call` and `apply`

The route applies only to call opcodes (`Call`, `CallContent`, `CallIgnoresRv`,
`CallIter`, `CallContentIter`), never to `New`, `NewContent` or `SuperCall`, so
`new (f.call)()` still rejects the builtin. Before anything changes it requires:
the callee is exactly the native `fun_call` or `fun_apply` of the current realm;
the realm does not observe native calls; and the target (the `this` operand) is
an interpreted function that is not a class constructor. Anything else runs the
builtin natively, unchanged.

- `f.call(t, ...args)`: the target moves into the callee slot and the
  remaining operands shift down one slot, so the existing inline call runs with
  one argument fewer and its cleanup lands on the builtin's slot. With no
  arguments, `this` is `undefined`. Cross-realm targets use the inline path's
  realm entry and exit.
- `f.apply(t)`, `f.apply(t, null, ...)` and `f.apply(t, undefined, ...)`: the
  target receives zero arguments, `this` is the first argument or `undefined`,
  and every later operand is dropped. The same inline call path runs.
- `f.apply(t, list)` with a packed `ArrayObject` of at most `ARGS_LENGTH_MAX`
  elements, or an `ArgumentsObject` with no overridden length, no overridden or
  deleted element and no forwarded (closed-over) argument: the elements are
  copied into an owned-arguments frame whose return pops the original operands.
  These are the guards of upstream's optimised `FunApplyArgsObj` and
  `FunApplyArray` routes in `jit/CacheIR.cpp`; with them, reading the length
  and elements runs no script, so skipping native `apply`'s length read is
  unobservable. The target must be in the current realm, because the owned frame
  skips the inline call path's realm entry. The target is delazified after the
  checks; the list and `this` are then reread from the traced operands.
- Every other list stays native: non-objects (the `TypeError`), array-likes,
  arrays with holes, proxies, over-limit lengths, overridden `arguments`.
  Upstream's order (callable check, then length, then elements) and its errors
  are untouched.

After the operands are rewritten, a failure (delazification, the frame limit,
out of memory) is an error at the call opcode, never a fallback to the builtin.
Frames from either route hold no recursion unit. `f.call.call(g)`, bound,
proxy and native targets, spread calls and `Reflect.apply` keep the native
route. PBL is unchanged: its `call` and `apply` keep the native route until a
later unit.

## Original adapters and controls

`crates/bunwasm-spidermonkey/tests/loop-dispatch.cpp` is an original embed test.
The `loop-controls` feature includes it in the existing native control driver.
`scripts/spidermonkey-loop-controls.ts` builds an instrumented copy of only
`Interpreter.o` in temporary storage and replaces that member in a private
archive copy. It never modifies the ordinary library. The additional C++ hooks
and frame-count accessor are compiled only with
`BUNWASM_INTERPRETER_CONTROLS`; release builds contain neither.

The controls compare recursion depth and frame count at evaluation boundaries,
force a shrinking GC between lookup and frame entry and between an `apply`
list's checks and its frame publication, exercise the shared half-initialized
prologue failure path from getter, `call` and `apply` frames, and install a real
Debugger in another compartment. They check hooks, forced return, exception
identity, native-call exclusion, caller locations, saved stacks, async parent
stacks and interruption. The synthetic prologue fault checks unwinding; it does
not simulate every allocator failure.

`scripts/spidermonkey-interpreter-frames.ts` is an original structural reader
using the repository's Wasm reader. It reports the constant shadow allocation,
parameters and locals of `Interpret`, `RunScript`, `ICInterpretOps` and both PBL
instantiations, rejecting an unrecognized prologue. Frame growth is reported
with measurements rather than inferred from recursion capacity.
