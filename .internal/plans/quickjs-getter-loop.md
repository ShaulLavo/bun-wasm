# QuickJS ordinary getters

Status: Approved.

Angular's Ajv code generator alternates ordinary getters, `super` getters and
native reduce callbacks. Those getter calls previously entered a new C
activation at every level. This unit moves only ordinary getter entry into the
running bytecode loop. The continuation core and CALL are the base unit;
reduce and apply remain separate work.

Use the existing `JSExecFrame` return shapes and owned-function byte. Property
reads replace one operand, method reads retain the receiver and append a result,
and `super` reads replace three operands. Keep the caller's operands unchanged
until a successful return. Preserve the original receiver and perform `super`
key coercion before lookup. Exotic and unsupported reads retain native lookup.

Own the selected getter before any poll or allocation, release it on either
refusal, and transfer it to the new ordinary record on success. Initialize all
callee entry registers, including `owned`, before entering the shared frame
setup. The existing teardown closes variable references before releasing the
function and popping the record. Coroutine frames never own ordinary records.

The ordinary header stays 104 bytes on wasm32 and 168 bytes on x86_64. Native
budgets, the 4 MiB frame limit, allocator backing and entry reservations stay
unchanged. Check the optimized interpreter's shadow frame as well as layout
assertions, native sanitizers and allocation fault injection.

Semantic snapshots precede the implementation in history. Exercise the new
fixture and unchanged getter semantics on QuickJS, JSC and Browser, then run
quality and Linux Chrome through the heavy runner. Measure getter completion
at 4,096 levels, native fallback depths, recovery and ordinary call/data-read
cost. Record Ajv progress without treating getter-only progress as Angular
acceptance. The coordinator owns independent review and landing.
