## Wasm stack guards

Class **Port**. The upstream files are QuickJS-ng `quickjs/quickjs.c` from
rquickjs-sys 0.13.0, and Bun's WebKit `Source/WTF/wtf/StackBounds.cpp` at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.

QuickJS disables its stack limit on WASI in both `JS_NewRuntime2` and
`update_stack_limit`. Remove those exceptions so the existing guards in the
interpreter, property accessors, JSON serializer, and parser work on the C
shadow stack. A wasm host keeps call frames outside linear memory, so those
guards see only part of each recursion level. The `js_reserve_wasm_frame`
macro, compiled only for WASI, reserves a constant number of shadow-stack bytes
in the recursive functions whose host frames are larger than their shadow
frames: the JSON serializer, parser and reviver, `Array.prototype.flat`, Proxy
traps (through `get_proxy_method`, renamed `get_proxy_method1` behind a
macro), bound and async calls, `ToPrimitive`, `JS_Call`, `JS_CallFree`, and
the expression, unary and statement parsers, and `re_parse_disjunction` in
`libregexp.c` through the same macro there. Sizes are measured per path; no
upstream algorithm or error changes. Our Rust engine adapter requests the
measured stack budget. It is original adapter code and retains no upstream
implementation.

The WebKit WASI port bounds the C shadow stack to a native recursion budget
below the host wasm call-stack limit, read from `BUN_WASM_STACK_KIB` when set,
while retaining JSC's exception reserve. Its separate C-loop JavaScript frame
reservation keeps its existing capacity. This extends the platform hunk in
`jsc/webkit-wasi.patch`; it changes no upstream JavaScript algorithms. The
browser executor's choice of budget in `web/src/engine-stack-budget.ts` is original
adapter code. It retains QuickJS's default on desktop Gecko Firefox after cold
overflow-safety checks at 1.25 times that budget. Safari, Firefox on iOS, and
unknown hosts keep the smaller QuickJS budget. Explicit environment overrides
remain unchanged. `web/tests/browser-quickjs-stack.ts` is an original browser
harness over the existing stack-depth fixture.

Desktop Firefox uses a measured 208 KiB JSC budget instead of the 192 KiB WebKit
fallback. Its original compiler regression in `web/tests/browser-solid-stack.ts`
loads the installed SolidStart source and Babel Solid preset without copying or
changing their implementations.
[Stack limits](../stack-limits.md) records the measurements and reproducer.

`tests/fixtures/stack-overflow-console/index.js` adapts the script in Bun's
`test/js/node/console/console-constructor-exception.test.ts` at upstream
`9510e74152073d850a18758ca41114d8f214ffa6`. Class **Port**. The local fixture
runs directly on all engines, verifies the caught error type, and prints a
fixed recovery marker instead of spawning a child test process.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, WASI stack checks](#wasm-stack-guards) | Port | Restore the stack checks on WASI and reserve shadow stack for host frames, so recursion throws before the host wasm stack runs out. |
| [`third_party/rquickjs-sys/quickjs/libregexp.c`, WASI stack reservation](#wasm-stack-guards) | Port | Reserve shadow stack per regexp group nesting level, so the parser's stack check trips before the host wasm stack runs out. |
| [`jsc/webkit-wasi.patch`, `StackBounds.cpp` budget](#wasm-stack-guards) | Port | Bound JSC's native recursion to a host-configurable budget below the host wasm stack. |
| [Console recursion fixture](#wasm-stack-guards) | Port | Adapt Bun's console-constructor stack exhaustion control to a standalone fixture. |

[Ledger scope and pinned revisions](scope.md).

## JSC native recursion accounting

The WASI additions to the same pinned WebKit's `JSArray.cpp`, `ProxyObject.cpp`,
`JSONObject.cpp`, `parser/Parser.cpp` and `WTF/wtf/StackBounds.h` are a **Port**.
`WASM_RESERVE_STACK` is an original accounting adapter. Its escaping constant
`alloca` keeps a reservation alive until the native function returns, including
exception returns. It changes neither the upstream recursion algorithm nor the
C-loop's JavaScript frame capacity.

The two fast flattening functions and default Proxy property reads reserve
512 shadow bytes per native frame. Fast JSON serialization reserves 1024 bytes. The assignment and
statement parsers reserve 2048 bytes. Fast JSON's static-buffer path also checks
the VM's soft limit. Its upstream stack estimate assumes native frames and cannot
by itself protect Wasm's separate host stack. Non-WASI builds add no reservation.

The browser adapter gives V8 800 KiB for JSC getter reentry only after these native
paths have their own accounting. QuickJS's V8 default and the Firefox, WebKit and
unknown-host policies remain unchanged. The `stack-getter-headroom` fixture keeps
128 nested getters and the previously caught native paths together, then checks
that getters still work after the exceptions. Native fixture discovery owns it.
The original `scripts/jsc-embedding.ts` host adapter reads that feature manifest
and also runs the same fixture on its matched JSC pair with a 1 MiB Node Worker
stack and the 800 KiB guest budget, requiring RangeError on all five paths.
Other engines may finish an operation iteratively, but must still continue. This is a blocking runtime control, not a source
pattern test. Real Chrome warm and fresh-context controls remain a separate
qualification step.

## QuickJS native call dispatch

The same QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0 now dispatches
native callable classes before entering the bytecode interpreter. This is a
**Port**. `JS_CallInternal` retains the original interrupt poll and native class
lookup. `JS_CallBytecode` owns the interpreter's locals and `JSStackFrame` only
for bytecode and generator execution. Previously a native `call` or `apply`
retained an unused interpreter activation throughout its callback into JavaScript.

The class call, flags, arguments, exception paths and current-frame bookkeeping
are unchanged. No stack budget or frame reservation is widened or removed.
The original `stack-native-call` fixture checks bounded call and apply recursion
at the 32 KiB Safari budget, followed by catchable overflow and recovery.
