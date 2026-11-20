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
adapter code. [Proxy [[Get]] forwarding](jsc-proxy-get-forwarding.md) separately removes
native recursion from empty-trap chains without changing their observable behavior. It retains QuickJS's default on desktop Gecko Firefox after cold
overflow-safety checks at 1.25 times that budget. Positively observed desktop
Safari uses 36 KiB after native-call frame removal and parser exception
preservation, with 29 cold controls passing at both 36 and 45 KiB on Safari 26.4.
The page sends platform, vendor and touch-count observations to root and spawned
workers. A Macintosh user agent alone cannot distinguish a desktop-style iPad.
iOS, iPadOS and unknown observations retain 32 KiB. This is not application-startup
acceptance. Explicit environment overrides and all JSC choices remain unchanged.
`web/tests/browser-quickjs-stack.ts` is an original browser harness over the existing stack-depth fixture.

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
| [`jsc/webkit-wasi.patch`, Proxy [[Get]] forwarding](jsc-proxy-get-forwarding.md) | Port | Forward empty-trap chains iteratively on WASI with the existing per-level stack charge. |
| [Console recursion fixture](#wasm-stack-guards) | Port | Adapt Bun's console-constructor stack exhaustion control to a standalone fixture. |
| [`jsc/webkit-wasi.patch`, unary and regexp accounting](#jsc-unary-and-regexp-accounting) | Port | Reserve shadow stack in unary bytecode generation and Yarr's recursive passes, and add the parser's stack check to `await` chains. |
| [`jsc/webkit-wasi.patch`, regexp matching errors](#jsc-regexp-matching-errors) | Port | Preserve interpreter recursion failures and report the existing catchable error instead of an ordinary no-match result. |
| [`jsc/webkit-wasi.patch`, parser reserve setting](#jsc-parser-reserve-setting) | Port | Let the statement and assignment parsers reserve a host-set number of shadow bytes, 2048 by default, while every other reservation stays constant. |

[Ledger scope and pinned revisions](scope.md).

## JSC native recursion accounting

The WASI additions to the same pinned WebKit's `JSArray.cpp`, `ProxyObject.cpp`,
`JSONObject.cpp`, `parser/Parser.cpp` and `WTF/wtf/StackBounds.h` are a **Port**.
`WASM_RESERVE_STACK` is an original accounting adapter. Its escaping constant
`alloca` keeps a reservation alive until the native function returns, including
exception returns. It changes neither the upstream recursion algorithm nor the
C-loop's JavaScript frame capacity.

The two fast flattening functions reserve 512 shadow bytes per native frame. Default Proxy
property reads reserve 512 at entry and at each iterative forwarding level, as
[Proxy [[Get]] forwarding](jsc-proxy-get-forwarding.md) records. Fast JSON serialization reserves 1024 bytes. The assignment and
statement parsers reserve 2048 bytes. Fast JSON's static-buffer path also checks
the VM's soft limit. Its upstream stack estimate assumes native frames and cannot
by itself protect Wasm's separate host stack. Non-WASI builds add no reservation.

[JSC iterative JSON fast stringifier](jsc-json-fast-iterative.md) moves plain fast-path container
traversal onto rooted heap frames on WASI. The reservation and soft check stay at `append` entry,
but container depth no longer adds native frames. Allocation refusal and the internal nesting cap
restart the unchanged general serializer.

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

## JSC unary and regexp accounting

The same pinned WebKit's `bytecompiler/NodesCodegen.cpp`, `yarr/YarrPattern.cpp`,
`yarr/YarrInterpreter.cpp` and `parser/Parser.cpp` get further WASI additions, class
**Port**. These recursions already had stack guards, but each level spends almost
no shadow stack, so the guards never fired before the host stack ran out.

Bytecode generation for `UnaryOpNode`, `UnaryPlusNode`, `TypeOfValueNode`,
`VoidNode`, `DeleteValueNode` and the negated-condition form of `LogicalNotNode`
reserves 1024 bytes per level. So do Yarr's recursive compile passes:
`copyDisjunction`, `copyTerm`, `setupAlternativeOffsets`,
`setupDisjunctionOffsets`, `recomputeStartsWithBOL`, `factorAlternatives`,
`termsMayMatchNewline` and `ByteCompiler::emitDisjunction`. The interpreter's
`matchDisjunction` reserves 2048. The reservations sit in each node's own
`emitBytecode` and not in the shared `emitNode` dispatcher, which is inlined at many
call sites and is also the path for long left-deep chains.

`parseAwaitExpression` recursed with no check at all. It now reserves 2048 bytes
and calls the parser's existing `failIfStackOverflow`: a chain of `await` that
would have crashed reports a stack overflow instead. The matching-error correction
below also preserves the error reported by Yarr's recursion guard.

The `stack-getter-headroom` fixture owns the regressions and also sweeps interior
depths, because a pattern shallow enough to compile can still reach a later pass.

## JSC regexp matching errors

The same pinned WebKit's `yarr/YarrInterpreter.cpp` and
`runtime/RegExpInlines.h` have a WASI-only **Port**. When matching exhausts its
recursion budget, the interpreter preserves `ErrorNoMemory` instead of returning
the unchanged no-match offset. Both `RegExp::matchInlineOnce` overloads turn that
result into the existing `TooManyDisjunctions` error, which reports a catchable
`RangeError`. A genuine no-match result is unchanged. Non-WASI builds are unchanged.

The added match reservation makes this previously silent error reachable with
fewer nested groups. The fixture compiles a modest quantified pattern before
native callback reentry, then checks successful `exec`, `test`, `replace` and
`matchAll` results at each depth. On JSC a call may match or throw `RangeError`,
but must not silently report no match. The portable fixture also accepts QuickJS's
catchable `SyntaxError` when `matchAll` compiles a regexp during deep reentry.
Wrong matching results still throw an ordinary `Error`, which is not accepted.
Shallow matching and a genuine non-match must still work after unwinding. This
control complements the compile-depth sweep, which cannot detect a lost match.


## JSC parser reserve setting

The same pinned WebKit's `parser/Parser.cpp` and `parser/Parser.h` get a further WASI-only
**Port**. `parseStatement` and `parseAssignmentExpression` no longer reserve a constant 2048
shadow bytes: they reserve 2048 minus a parser-owned discount, through the unchanged
`WASM_RESERVE_STACK` macro. The discount is one zero-initialized 32-bit variable in `Parser.cpp`,
so zero-filled side data means the full 2048 before and without any initializer. `Parser.h`
declares the one setter, `setWasmParserReserve`, which takes the reserve in bytes, requires 512
through 2048 in multiples of 16 and stores the discount. The recursive path loads the variable and
subtracts. It reads no environment, allocates nothing and initializes nothing lazily.

Nothing else in the patch moves. The other 21 `WASM_RESERVE_STACK` sites keep their constants,
including `parseAwaitExpression`. `StackBounds.cpp`, the hard and soft limits, the 128 KiB
exception reserve, the regexp matching errors and every budget are unchanged, and no upstream
algorithm changes. Non-WASI builds compile as before: the macro discards its argument there.

The chain functions of [JSC assignment chains](jsc-assignment-chains.md),
`parseAssignmentChainLevel` and `parseAssignmentChainRest`, reserve the same `2048` minus the
discount at their entries, so four sites read it: `parseStatement`, `parseAssignmentExpression`
and those two.

A runtime-sized reservation still dies when its function returns, so error paths need no release.
On the final side the default's capacities equal the constant version's (98, 105 and 353
assignment targets at 192, 208 and 800 KiB), so the frame costs did not change.

Original adapters, none of which retains an upstream implementation:

- `crates/bunwasm-jsc/cpp/helpers.cpp` parses `BUN_WASM_JSC_PARSER_RESERVE` strictly and makes
  the single setter call inside the existing `JSC::initialize` callback, once per side instance,
  before that instance's only VM exists. An invalid or absent value makes no call.
- `web/src/engine-stack-budget.ts` holds the host table and the selected value, 960 for desktop
  Firefox on Linux, measured on that host. Desktop Safari keeps 2048: the 832 override measured
  on Apple silicon is not selected automatically because the browser observations used here do
  not distinguish it from unqualified Intel hosts.
  `web/src/bun-executor.ts` adds the budget and the reserve independently, the reserve only for
  JSC. The run request's existing `stackHost` field carries the page's platform, vendor, and
  touch-point observations for both engine policies. QuickJS's desktop Safari selection is unchanged.
- `tests/stack-depth.js`, `scripts/stack-measurement.ts`, `scripts/measure-stack.py` and
  `web/tests/browser-stack.mjs` gain the parser chains (five shapes, two parser passes, two source
  widths), an `await`-chain control, the guest's reported settings and a parent-and-Worker mode.
  Capacity and ownership measurements first run the complete search loop at zero depth. This
  completes its first execution before the capacity observations on portable baseline.
  The requested-depth search and all before/after, parent/child and reserve comparisons remain.
  Individual chain actions and their cold overflow controls are unchanged.
- `scripts/jsc-parser-reserve.ts` runs the gate's tuples and the file threshold search.
  `web/tests/browser-jsc-parser-reserve.ts` and `web/tests/parser-reserve-ownership.ts` are the
  browser harnesses, and `tests/fixtures/shared-wasm-memory/parser-reserve-ownership.ts` is the
  group case's guest half.
- `tests/fixtures/parser-chain-stack` is an original fixture. It copies no package: it generates
  the 100-target chained export assignment that Babel's generated builders reduce to.

[Stack limits](../stack-limits.md#jsc-parser-reserve) records the contract, the host table and the
measurements.

## Stack measurement acceptance

`scripts/stack-measurement.ts`, `scripts/measure-stack.py` and
`web/tests/browser-stack.mjs` are original measurement adapters. They retain every
failed attempted depth in each row's `failures` list, including binary-search
trials. A later caught boundary cannot erase an earlier trap. Both commands
return nonzero for any failed trial. The browser command closes its contexts,
browser and session before exiting. Python's subprocess timeout kills and reaps
the attempted launcher before recording the timeout.

A valid result identifies the requested mode and depth, exits zero and prints a
separate `continued` line after its one result line. Completion is accepted on all
paths. `RangeError` is accepted except on `console`, whose fixture swallows the
overflow internally and must complete. `SyntaxError` is also accepted for source
parsing and regexp construction modes (`parse`, `block`, `arrow`, `unary`, `power`,
`ternary`, `statement`, `awaitchain`, `regexpnc`, `lookahead` and the 20 parser chains). Browser-native Firefox may
report `InternalError` with the exact message `too much recursion` instead of
`RangeError`. Other caught classes, malformed results, missing continuation,
nonzero exits and timeouts fail measurement acceptance. This validates the
existing probe protocol, not matching correctness or a new stack policy.

`checks/web-stack-measurement.json` registers executable controls using fake
launchers and browser providers. They run the real command entry points without
building a guest or launching a browser, including hidden intermediate traps,
final trap flags, transcript validation, timeout reaping and cleanup.

The measurement transcript requires one result and exactly one later standalone
`continued` marker. Duplicate continuation markers fail both real command paths.
Measurement test scratch follows the host temporary-directory API, including
normal CI where this workstation's `/work` path does not exist.

`web/tests/browser-stack-safari.ts` is the original adapter for genuine desktop Safari. It drives
the same probe, classifier, search and fixtures over SafariDriver, through the goals matrix's
native driver and transport, and it copies no upstream code. A cold attempt is a new SafariDriver
session on a new document. `stackModeSlice` in `scripts/stack-measurement.ts` splits one sweep into
consecutive parts that together cover every path once, so a sweep can hold the shared Mac in short
turns. The adapter checks that Safari fetched the JSC side the site holds and prints the session's
capabilities.

Each measurement operation uses the goals matrix's `Scope` and `scoped` transport, with the
native driver's cancellation signal. Polls retain their operation's deadline. Warm commands
receive separate scopes, so one attempt's budget does not expire the entire sweep. Session
closure interrupts pending commands and runs even after cancellation. Source-only admission
checks exercise late observations, cancellation, warm reuse and foreground timeout cleanup.
