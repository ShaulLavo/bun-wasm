# QuickJS getter dispatch and builtin loop continuations

Class **Port**. Upstream is QuickJS-ng 0.16.2 in rquickjs-sys 0.13.0,
imported at `902364cf9`. The adapted implementation is
`third_party/rquickjs-sys/quickjs/quickjs.c`.

`Function.prototype.call` forwards ordinary bytecode targets within the running
interpreter. A continuation record preserves the original builtin object, its
realm and its native stack frame while the target executes. Bound, proxy,
native, generator and async targets retain upstream dispatch. Replaced builtins
also retain their own dispatch. Arbitrary C calls never suspend C activations.

Ordinary records return to either another ordinary record or a continuation.
Their return shape counts the caller operands to release after success. Throws
leave those operands for the existing unwinder. C entries have no resume record,
even when a continuation is already linked. Coroutine frames retain their
separate ownership and return path.

CALL borrows its target, receiver and writable argument slots from the creating
record's operands. Zero actual arguments use a NULL vector. Formal padding and
closing captured arguments use ordinary bytecode entry and teardown. A native
continuation frame exposes actual arguments without native-length padding;
native frame readers must not index that vector. Stack and CallSite readers use
the original builtin object and frame linkage.

The continuation initializes its owned result before linking. Its step consumes
the target's owned return value or exception signal. One final disposer moves
and clears the result, unlinks the native frame and pops storage. The pending
exception object remains owned by the runtime. Allocation and interrupt refusals
take the same return path and allow subsequent calls to run.

The ordinary header stays 104 bytes on wasm32 and 168 bytes on x86_64. Record
kind and function ownership occupy existing padding. Continuation allocation
rounds its actual structure's tail up to value slots, with compile-time layout,
alignment and containment assertions. This unit adds no reduce or apply state.
Budgets, backing limits and native entry reservations are unchanged.

Ordinary JavaScript getters selected by `OP_get_field`, `OP_get_field2` and
`OP_get_super_value` also enter the running interpreter. Their result replaces
one, zero or three caller operand slots respectively. Lookup keeps the original
receiver, including inherited and `super` reads. `super` coerces its key once
before searching ordinary prototypes. Exotics, computed ordinary keys, data,
VARREF and AUTOINIT properties, native getters, async functions and generators
retain the existing property lookup and native call paths. Coroutine callers
retain native dispatch.

The selected getter is duplicated before interrupt polling or frame allocation.
The callee record owns that reference until its normal or exceptional teardown.
Interrupt and allocation refusal release it before unwinding the caller, whose
operands remain intact. No property pointer is used after a poll. Zero actual
arguments use a NULL vector and declared formal slots receive undefined.

Original regression adapters are `scripts/fixtures/quickjs-frame-stack.c` and
`.ts`, driven by `scripts/check-quickjs-frame-stack.ts`, plus the engine-neutral
native fixture `tests/fixtures/stack-loop-continuations`. The semantic snapshot
was captured from the engine before this dispatch change.

Getter-specific original adapters extend those same bare-engine fixtures and
add `tests/fixtures/stack-getter-loop`, discovered by
`checks/native-stack-getter-loop.json`. They cover selected-getter collection
during an interrupt, accessor mutation, receiver and key semantics, formal
padding, escaping references, refused allocations, unbounded recursion and
recovery at the unchanged 32 and 36 KiB native budgets. Getter dispatch removes
only one part of Ajv's getter/reduce recursion; Angular acceptance also needs
the separate reduce continuation unit.
