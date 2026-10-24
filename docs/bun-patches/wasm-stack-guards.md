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
browser worker's choice of budget in `web/src/worker.ts` is original code.
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
