# Stack overflow in wasm

Deep recursion must reach the engine's own stack guard, which throws a catchable
`RangeError`, before the wasm host runs out of call stack. A host stack overflow is a
wasm trap: it ends the program, and no JavaScript `catch` runs.

## Three stacks

The module has three independent stacks:

- **Host call stack.** The wasm engine keeps every function activation (its locals
  and spills) outside linear memory. Its size belongs to the host: wasmtime's
  `max_wasm_stack` (512 KiB by default; 16 MiB in the native launcher), V8's stack
  limit in Node and Chromium, and the worker thread's stack in WebKit. The module
  cannot read how much of it is in use.
- **C shadow stack.** Address-taken C and Rust locals, `alloca` and large structs live
  in an 8 MiB region of linear memory set by `crates/bunwasm-cli/build.rs`. Engine
  stack guards measure this one.
- **JSC's C-loop stack.** JSC's interpreter keeps JavaScript frames in a separate
  5 MiB reservation, so JS-to-JS calls on JSC do not grow either native stack.

Enlarging the shadow stack does not enlarge the host stack. A guard that counts
shadow bytes protects the host stack only when each recursion level spends shadow
bytes in proportion to its host frames.

## The smallest host

On Apple platforms WebKit gives worker threads the system default stack, 512 KiB
(`stackSize()` in WebKit's `Source/WTF/wtf/Threading.cpp` returns no size there), and
JSC keeps a 128 KiB reserve below that. The playground runs bun.wasm in a worker, so
Safari on macOS and iOS has the least host stack. Playwright's WebKit on Linux sizes
threads from `RLIMIT_STACK` instead (8 MiB here), which overstates Safari about
fourteenfold. Running the browser under `ulimit -s 512` gives its worker threads
Darwin's default size. Playwright WebKit on the owner's M1 Mac runs on real Darwin
worker stacks and ARM64, the same architecture and engine as iOS; it was the tighter
of the two and sets the browser budget. Neither is an iOS device: no measurement on
iOS Safari itself exists.

JavaScriptCore first runs wasm in an interpreter whose frames are two to three
times larger than its optimized code's, and a function keeps those frames until it
tiers up. The first deep recursion through a function, often the first run after
the page loads, therefore has the least room. V8 starts with a baseline compiler
whose frames are close to its optimized ones; in Chromium and Node every path
behaved the same on the first run as on later ones.

## QuickJS

QuickJS-ng in rquickjs-sys 0.13.0 disables its stack limit on WASI in both
`JS_NewRuntime2` and `update_stack_limit`, so the previous 4 MiB
`set_max_stack_size` request did nothing. The port restores the existing checks.

The checks count shadow bytes, but recursion paths spend the two stacks in very
different proportions. Measured on wasmtime before any change, host bytes per shadow
byte were 1.9 for plain calls, 2.4 for getters, 13 for `JSON.stringify`, 11 for
`JSON.parse` and 21 for nested source code. A single byte budget small enough for
the parser would leave about 300 plain calls. Instead, `js_reserve_wasm_frame` in
`quickjs.c` makes recursive C paths that keep few locals in memory reserve shadow
bytes for their host frames. The serializer, JSON parser and reviver, the parser's
expression and statement levels, the regexp parser (`libregexp.c`), `Array.prototype.flat`, Proxy traps, bound
functions, async resumption, `ToPrimitive` and C-to-JavaScript calls reserve. After
that every measured path spends at most 1.9 host bytes per shadow byte (0.8 to 1.9). The
reservation is a constant-size `alloca` whose pointer escapes. It is freed when the
function returns, so it needs no bookkeeping on error paths.

Sizing, per recursion level, on wasmtime. "Host" is the marginal host stack per level
on the pre-change build (1 MiB against 2 MiB host stacks). "Shadow before" is from the
restored checks without reservations, and "shadow after" from the final build at a
6 MiB host stack. Redo these after a QuickJS upgrade with the commands under
Reproduce, then size each reservation so host/shadow stays at or below 1.9:

| Path | Host B | Shadow before | Reservations (bytes) | Shadow after | Host/shadow after |
| --- | ---: | ---: | --- | ---: | ---: |
| Plain call | 512 | 275 | none | 310 | 1.65 |
| Getter | 736 | 308 | `JS_CallFree` 64 | 408 | 1.80 |
| Proxy trap | 816 | 372 | `get_proxy_method` 240, `JS_CallFree` 64 | 689 | 1.18 |
| `JSON.stringify` | 208 | 16 | `js_json_to_str` 96 | 115 | 1.81 |
| `JSON.parse` | 176 | 16 | `json_parse_value` 80 | 116 | 1.52 |
| Reviver | 224 | 49 | `internalize_json_property` 64 | 181 | 1.24 |
| Nested array literals | 1,713 | 81 | 48 per expression-parser frame, `js_parse_unary` 80 | 961 | 1.78 |
| Nested blocks | 464 | 130 | `js_parse_statement_or_decl` 96 | 248 | 1.87 |
| Nested arrows | 2,305 | under 163 | expression-parser frames | 1,235 | 1.87 |
| Unary chain | 176 | — | `js_parse_unary` 80 | 100 | 1.76 |
| Conditional chain | 208 | — | expression-parser frames | 166 | 1.25 |
| `if` chain | 352 | — | `js_parse_statement_or_decl` 96 | 199 | 1.77 |
| Regexp groups | 288 | 178 | `re_parse_disjunction` 160 (in `libregexp.c`) | 344 | 0.84 |
| Proxy chain | 304 | 97 | `get_proxy_method` 240 | 376 | 0.81 |
| Bound chain | 656 | 258 | `js_call_bound_function` 80 | 442 | 1.48 |
| Nested arrays to string | 2,048 | 745 | `JS_ToPrimitiveFree` 192, `JS_CallFree` 64 | 1,162 | 1.76 |
| `toString` reentry | 1,727 | 662 | `JS_ToPrimitiveFree` 192, `JS_CallFree` 64 | 998 | 1.73 |
| `Array.prototype.flat` | 224 | 48 | `JS_FlattenIntoArray` 64 | 180 | 1.24 |
| Async recursion | 1,360 | 566 | `async_func_resume` 128 | 819 | 1.66 |

The budget is the host's choice. `crates/bunwasm-runtime/src/engine_quickjs.rs`
uses `BUN_WASM_STACK_KIB` when the host sets it, and 152 KiB otherwise. The same
variable sets JSC's budget below; the two engines have different defaults. The
defaults fit wasmtime's 512 KiB default stack, so `wasmtime run` as in the README
and Chromium catch every measured path; the wasmtime CLI still does with a 320 KiB
host stack.

Hosts we control give the guest more. The native launcher
(`crates/bunwasm-host/src/main.rs`) sets `max_wasm_stack` to 16 MiB, runs every
instance, children included, on a thread with a 24 MiB native stack, and passes
4096 KiB to both engines. The Node host (`web/scripts/node-host.mjs`) runs every guest,
the top-level one too, in a Worker whose thread Node creates with a 32 MB stack
(`resourceLimits.stackSizeMb`; `--stack-mb` overrides it), and passes 6144 KiB. The
host stays one process, so killing it ends the guest, and `ulimit -s` does not matter.
On 2026-10-16 the launcher still caught every path with a budget one and a half
times as large (6144 KiB). That margin no longer holds for QuickJS: measured on
2026-11-11, a 6144 KiB budget with the launcher's default host stack traps on
getters, constructors, `call`, `apply` and array callbacks, on the build
before the frame stack as well as after it. Plain calls trap only before the
frame stack. The launcher's own 4096 KiB default
still catches every measured path ([ordinary call frames](#ordinary-call-frames)).
On the Node host the stack was shrunk instead: with the 6144 KiB default and a
21 MB Worker stack (32/1.5), all 25 paths still threw or completed on QuickJS and
JSC in October; that has not been measured again.
Browsers cannot raise their stacks; that is the platform limit behind their smaller
depths.

`BUN_WASM_STACK_KIB` is clamped to 7 MiB in both engines, below the 8 MiB shadow
stack, so no value can wrap to "no limit". Values that are not positive decimal
numbers keep the default. The clamp keeps the guard alive, but it does not make a
budget fit the host: a budget larger than the host stack allows traps as before.
The browser executor (`web/src/engine-stack-budget.ts`) gives QuickJS 36 KiB only
when the worker has Safari's full Macintosh user agent and the page reports
`MacIntel`, Apple's vendor, and exactly zero touch points. The page launcher
carries these observations to every root and spawned worker because
`WorkerNavigator` does not expose `maxTouchPoints`. Desktop-style iPad user agents
alone cannot select this budget. iOS, iPadOS, other WebKit hosts and missing or
unknown observations retain 32 KiB. Explicit environment overrides are unchanged.
V8 and desktop Firefox keep QuickJS's 152 KiB default. All JSC and browser-engine
choices are unchanged.

After native-call frame removal and parser exception preservation, the measured
36 KiB candidate clears the original Minipass and RxJS module-body boundaries.
It does not prove application startup. React Router next fails esbuild resolution,
and Angular has a later RangeError. On desktop Safari 26.4, 59 fresh sessions
passed an original 32 KiB native-call calibration and 29 controls at both 36 KiB
and its full 1.25-times margin of 45 KiB. Those controls retain all 25 recursion
inputs, both overflow fixtures, native-call semantics and parser recovery.
This evidence does not qualify iOS, iPadOS, unknown hosts or a larger budget.

Desktop Firefox uses a measured 208 KiB JSC budget.
Desktop Firefox was measured with all 25 recursion cases below, each in a fresh
browser context. At both 152 KiB and a 190 KiB margin, every case completed or
threw a catchable exception and continued. Both stack-overflow fixtures also
passed at 190 KiB. Giving Firefox the smaller WebKit budget needlessly rejects
React Router's ordinary CommonJS dependency loading. Firefox on Android remains unmeasured and keeps the smaller budget. Firefox on iOS
still uses WebKit and keeps it too. Unknown Firefox platforms also keep the
smaller budget.

### Statement nesting

QuickJS no longer parses nested statements by recursion
([statement parser](bun-patches/quickjs-statement-parser-stack.md)). A statement
that contains statements keeps its state in a parser-owned heap record, so a
nested block, `if`, loop, `switch`, `try` or labelled statement adds no call
frames. The two statement rows in the sizing table above and in the tables
under Measurements describe the recursive parser this replaced: they have no
per-level cost now. The driver still reserves 96 bytes once per entry, because
functions inside expressions re-enter it.

The parser stops at 10,000 records suspended at once in one parse and throws the
same catchable `RangeError`. That counts records, not source statements: a
statement holding a statement keeps one record and a braced body adds one, so
a braced `if` nests 5,000 deep and an unbraced one 10,000. The bound is the
same on every host. It is higher than any browser budget allowed and lower than
the native launcher's old 17,456 blocks at 4096 KiB. It bounds record storage,
about 1.1 MB at the limit, and nothing else: compiling deep code still costs
memory for scopes and bytecode, and running it still needs the interpreter's
stack for forms that keep a value per level, such as nested `switch`.

Measured on November 10, 2026 on the native launcher with the host Wasm stack
cut to 512 KiB, comparing the QuickJS side from main's CI with this change.
Each number is the deepest nesting that completed; one level more threw
`RangeError`.

| Path | 32 KiB before | 32 KiB after | 36 KiB before | 36 KiB after |
| --- | ---: | ---: | ---: | ---: |
| Plain calls | 100 | 100 | 113 | 113 |
| Nested array literals | 30 | 30 | 35 | 35 |
| Nested arrows | 23 | 24 | 27 | 28 |
| Unary chain, `**` chain | 292 | 292 | 334 | 335 |
| Conditional chain | 175 | 175 | 200 | 201 |
| Nested blocks | 121 | 10,001 | 138 | 10,001 |
| `if` chain | 147 | 10,000 | 168 | 10,000 |
| Function expressions | 11 | 12 | 13 | 14 |
| Function declarations nested directly | 423 | 425 | 487 | 489 |
| Functions nested through `if` blocks | 38 | 103 | 44 | 119 |
| Functions nested through `for` bodies | 39 | 106 | 45 | 122 |
| Functions nested through `try` | 55 | 106 | 63 | 122 |
| Functions nested through `switch` | 59 | 103 | 68 | 119 |
| Arrow in a call argument | 19 | 20 | 22 | 23 |
| Class methods | 80 | 80 | 92 | 93 |

Blocks read 10,001 because an empty innermost block needs no record. No path
that still recurses is shallower than before. With the same 512 KiB host stack,
about 4,900 nested levels of every statement kind compile at both budgets
(`tests/fixtures/quickjs-parser-deep`), which the recursive parser would have
needed several megabytes of host stack for. The control for that host limit:
plain recursion is caught at depth 102 at 32 KiB, and traps when the guest
budget is raised above the host stack.

This is why generated validators now compile: the webpack bundle Next 15.5.6
ships nests 80 `if` blocks, and `next dev` passed that file at 36 KiB in a
native run. It does not make Next start at 36 KiB. The same run then stopped
with a `RangeError` on TypeScript's own library, which Next loads to read
`next.config.ts`. That file compiles. The refusal comes from the interpreter's
check on entering a function: the library is one wrapper function with 5,278
local variables, and its frame alone is 63,316 bytes, more than the whole
budget, with under 3 KiB in use. Angular's `ng serve` fails at 36 KiB for a
third reason, call depth: Ajv compiling schemas in JavaScript uses the whole
budget. Neither is a parser limit, and
[ordinary call frames](#ordinary-call-frames) takes both up. These are
launcher measurements of the guest's own guard at the unchanged budget, not
Safari runs.

### Ordinary call frames

QuickJS no longer keeps a bytecode call's arguments, locals and operand stack
in the interpreter's C frame, and an ordinary function calling an ordinary
function no longer makes a C call
([frame stack](bun-patches/quickjs-frame-stack.md)). Two limits replace the
one:

- **The frame limit** bounds the allocator-declared backing held by ordinary
  frame segments, with a 4 MiB default and maximum. The qualified split
  allocator charges 64 KiB per default segment, including allocator overhead.
  A plain recursive call costs about 121 bytes, so 34,746 of them fit, at a
  32 KiB budget as at 4096 KiB. One more throws the same catchable `RangeError`.
  The shared-group profile is not qualified by these split measurements.
- **The native budget** still bounds every call that re-enters the interpreter
  from C: constructors, `call` and `apply`, accessors, proxies, native
  callbacks such as `Array.prototype.map`, and generator and async functions.
  Those cost host stack at every level, as before.

A function's size is no longer depth. A function with 5,300 captured locals
runs at 32 KiB (`tests/fixtures/stack-frame-storage`); before, its frame alone
exceeded the budget.

Measured on November 11, 2026 on the native launcher, comparing the QuickJS
side with the statement parser change against the corrected split frame
allocator. Both sides use the same core and launcher. The first two budgets
ran with the host Wasm stack cut to 512 KiB, the third with the launcher's
defaults. Each number is the deepest nesting that completed; one level more
threw `RangeError` and the program continued. The first seven rows are
`scripts/measure-stack.py` inputs; the rest come from a one-off probe of the
same shape for routes that script does not cover.

| Path | 32 KiB before | after | 36 KiB before | after | 4096 KiB before | after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Plain calls | 100 | 34,746 | 113 | 34,746 | 13,789 | 34,746 |
| Promise callback | 108 | 34,752 | 121 | 34,752 | 13,797 | 34,752 |
| Nested `require` | 27 | 57 | 31 | 67 | over 512 | over 512 |
| Getter | 76 | 77 | 86 | 88 | 10,480 | 10,481 |
| Proxy trap | 45 | 46 | 51 | 52 | 6,238 | 6,239 |
| `toString` reentry | 44 | 46 | 50 | 52 | 6,093 | 6,239 |
| Async recursion | 59 | 65 | 67 | 73 | 8,187 | 8,734 |
| `Reflect.construct` | 77 | 83 | 87 | 94 | 10,481 | 10,920 |
| `new` | 101 | 105 | 115 | 118 | 13,791 | 13,794 |
| `Function.prototype.call` | 69 | 74 | 78 | 84 | 9,358 | 9,708 |
| `Function.prototype.apply` | 64 | 72 | 73 | 81 | 8,734 | 9,361 |
| `Array.prototype.map` callback | 62 | 67 | 71 | 76 | 8,453 | 8,737 |
| `Array.prototype.reduce` callback | 37 | 65 | 42 | 73 | 5,039 | 8,455 |
| Setter | 62 | 66 | 70 | 75 | 8,452 | 8,736 |
| Derived constructor | 47 | 52 | 53 | 59 | 6,390 | 6,897 |

The other 19 `measure-stack.py` inputs also completed or threw and continued at
all three budgets, none shallower than before. `reduce` and `require` gain most
among the native routes because the callback or the module wrapper now calls
its function inline, which leaves one native entry per level where there were
two.

Moving frame storage off the shadow stack removed bytes the guard had been
counting for each native entry, while the entry's host frames shrank less: about
128 host bytes against 60 to 100 guarded bytes. The interpreter's C entry
therefore reserves 48 bytes. With only 16, the guard allowed 11,913
`Reflect.construct` levels at 4096 KiB where the launcher's 16 MiB host stack
holds 11,520, and that recursion trapped; `tests/fixtures/stack-overflow` caught
it. With 48 the guard stops it at 10,920 levels, about 15 MiB of host stack,
where the build before used 15.8 MiB at 10,481. On every route in the table the
host stack in use when the guard refuses at 4096 KiB is lower than before. That
is a wasmtime measurement of one launcher build. It is not a browser result:
JavaScriptCore's wasm tiers have their own frame sizes, and Safari is measured
separately.

`next dev` now starts at 36 KiB in a native run and its first render returns
HTTP 200: TypeScript's library frame no longer counts against the budget, and
acorn's 152 nested calls while parsing Next's client entry run inline.
Angular's `ng serve` still fails at 36 KiB. Its depth is native: each level of
Ajv's code generation reads an accessor that folds its children with
`Array.prototype.reduce`, one accessor and one native callback per level, and
those keep their C calls. These are launcher runs of the guest's own guard, not
Safari runs.

### Native callable frames

QuickJS dispatches native callable classes before entering the bytecode
interpreter. On the production WASI build, the old dispatcher reserved a
288-byte interpreter activation even for native calls. The extracted dispatcher
reserves no shadow bytes; only bytecode and generator execution enter that
activation. `Function.prototype.call` and `apply` no longer keep the unused frame
while reentering JavaScript. Interrupt polling, native class dispatch, frame
bookkeeping and the stack guards are unchanged.

At the unchanged 32 KiB budget, the `stack-native-call` fixture now completes
55 nested calls through both methods, catches unbounded apply recursion and
continues. The same production core with the old engine fails that fixture on
both the native launcher and desktop Safari 26.4. All 25 recursion paths and both
overflow fixtures also recover in fresh Safari sessions at 32 KiB and the existing
40 KiB safety margin. These are stack controls, not framework acceptance results.
The browser-guest manifest discovers the cold WebKit check; the native manifest
discovers the focused fixture. The guest's 8 MiB shadow stack, 7 MiB override clamp
and browser budget remain unchanged.

## JSC

JSC's plain JavaScript calls stay in the C-loop and already throw. So do `object.name`
and `super.name` getters written in JavaScript, since November 11, 2026
([Getters called in the loop](#getters-called-in-the-loop)). Computed-key getters, Proxy
traps and other C++ reentry start a new `CLoop::execute` activation for each level.
It costs about 2.1 KB of host stack and 5.8 KB of shadow stack. The WASI
`StackBounds` port in `jsc/webkit-wasi.patch` limits native recursion to 320 KiB of
shadow stack by default, or `BUN_WASM_STACK_KIB` when the host sets it, plus
JSC's existing 128 KiB exception reserve. JSC's `maxPerThreadStackUsage` option cannot do this:
in the C-loop build it also sizes the separate JavaScript frame stack, and 448 KiB
cut plain recursion from 63,887 calls to 4,085.

With every function in its first tier, getters have room for 57 levels in Linux
WebKit under `ulimit -s 512` and 45 in WebKit on the Mac, where 224 KiB stopped them at
39 and 280 KiB let them trap. The browser worker therefore passes 192 KiB on
WebKit and unmeasured hosts: getters stop at 34, and at 240 KiB (1.25 times) every
reentry path and fixture still passes on the Mac.

Desktop Firefox uses 208 KiB. On Firefox 157 on Linux, the real SolidStart
`StartServer.jsx` SSR compiler fails at 192 KiB in Babel's recursive code generator
and succeeds at 208 KiB. All 25 recursion paths and both overflow fixtures complete
or throw catchable exceptions at 208 KiB and at a 260 KiB margin, 1.25 times the
budget, each in a fresh browser context. Restoring JSC's full 320 KiB default is
not safe here. The unary bytecode emitter traps at 280 KiB and 320 KiB where the
smaller budgets reject the input first. The Firefox adjustment leaves the guest
guard and exception reserve intact. Android, iOS, and unknown hosts retain 192 KiB.
The focused compiler regression is `web/tests/browser-solid-stack.ts`. The actual
SolidStart template also passes dev rendering, click, hot reload, build, and
production preview on this Firefox/JSC host. These measurements were taken on
2026-11-09.

The V8 browser policy gives JSC 800 KiB for getter reentry. Native recursive
paths with small shadow frames now reserve extra shadow bytes: 512 in both fast
flattening functions and default Proxy reads, 1024 in fast JSON serialization,
and 2048 in assignment and statement parsing. The static JSON fast path also checks the
VM's soft stack limit instead of relying only on its native-frame buffer estimate.
These reservations do not enlarge the host stack or the C-loop frame stack.
Firefox, WebKit and unknown hosts keep their existing budgets. The focused
`stack-getter-headroom` fixture covers 128 getters, the five previously caught
paths, and getter recovery after the exceptions. The blocking JSC embedding gate
also runs it with a 1 MiB Node Worker stack and 800 KiB guest budget, so a large
launcher stack cannot hide missing native-frame reservations.

Measured on November 9, 2026 in Google Chrome 157 on Linux, getters reach 142
levels with the 800 KiB browser policy, compared with 56 at 320 KiB. The exact
Ajv 8.17.1 CommonJS schema-registry control needs 127 getter levels and completes.
The focused fixture also passes at 1000 KiB, a 1.25-times margin, including getter
recovery after all five native exceptions. The same fixture passes on a 1 MiB
Node Worker stack at 800 KiB and a 21 MiB Worker stack at the unchanged 6144 KiB
Node policy. These are stack controls, not an Angular application qualification.

Unary operators and regular expressions had guards that never fired, because each
level spends almost no shadow stack. Unary bytecode generation and every Yarr
recursive compile pass now reserve 1024 bytes per level, the Yarr interpreter 2048,
and `await` chains, which had no parser check, reserve 2048 and check. In Google
Chrome 157 on Linux the original browser-stack probe shows no trap on any of its 25
paths, warm or in fresh contexts, and getter capacity stays at 142. The fixture also
passes at the default budget, 800 KiB and 1000 KiB, and on a 1 MiB Node Worker stack.

The trade is depth. On a 1 MiB wasmtime stack at 800 KiB, regexp groups completed
to 2,000 levels and trapped by 3,000 before; they now complete to 300 and throw a
catchable error from 400. Unary chains completed to 5,000 and trapped by 10,000;
they now complete to 700 and throw from 1,000, and `await` chains complete to 400
and throw by 700.

These depth measurements start with a shallow matching stack. A pattern compiled
there can still exhaust the interpreter during native callback reentry. On WASI,
that matching failure now keeps its error result and throws the existing
`RangeError` instead of silently returning `null` or `false`. The fixture checks
successful `exec`, `test`, `replace` and `matchAll` results during reentry, then
checks matching and a genuine non-match after unwinding.

This is not a claim that every shape is safe. Long left-deep chains (`x+x+…`,
`x&&x&&…`, `x.a.a…`, `x()()…`) still trap at 200,000 levels on wasmtime. They
recurse in bytecode generation too, but generated code can really be that long, so a
fixed reserve would cost working depth and needs its own design. Blocks and
conditional expressions throw. The extra accounting can reduce native-path nesting
capacities on other hosts. No new Darwin or iOS measurement is claimed.

### Getters called in the loop

Until November 11, 2026 every getter was C++ reentry, and the "getter" numbers above and
in the tables below measure that reentry. The real Ajv 8.17.1 code generator, which reads
`node.names` and `super.names` once per nested `if`, stopped after 16 levels at 192 KiB
and 17 at 208 KiB. Angular's schema registry nests about 64, and Safari's worker stack
has room for about 45 activations at any budget.

`object.name` and `super.name` now call a JavaScript getter from the running loop
([record](bun-patches/jsc-getter-dispatch.md)). Such a getter costs what a plain call
costs, and its depth is bounded by the C-loop frame stack's own check, which throws the
same `RangeError`. Budgets, reserves and every other path are unchanged. The `getter`
probe therefore no longer measures reentry on JSC. `computedgetter` reads the same getter
through a key the compiler cannot see, which JSC still calls from C++, and takes over
that role. `ajvnames` is the Ajv walk reduced to its getters, and `ajv` runs the real
package.

Measured on November 11, 2026 on the native launcher: the split JSC pair from main's CI
(source tree of `19dba71e`), and the same core with a side built from this change. A
number is the deepest nesting that completed; one level more threw `RangeError`.

| Path | 192 KiB before | After | 208 KiB before | After | 800 KiB before | After |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `getter` | 34 | 39,930 | 36 | 39,930 | 142 | 39,930 |
| `ajvnames`, 4,096 tried | 16 | completes | 18 | completes | 72 | completes |
| `ajv`, the real package, 4,096 tried | 16 | completes | 17 | completes | not run | not run |
| `computedgetter` | 35 | 35 | 38 | 38 | 147 | 147 |
| `proxy` | 29 | 29 | 32 | 32 | 124 | 125 |
| `tostring` | 31 | 31 | 34 | 34 | 133 | 133 |

The other 44 paths of the sweep, the 20 parser chains among them, gave identical results at
all three budgets. The Proxy read gains one level at 800 KiB because the edited
`get_by_id` slow path's frames came out 48 guarded bytes smaller per level (6,512, was
6,560). The same cycle has fewer wasm locals (419, was 429), and with the guard out of the
way wasmtime ran out 15% deeper on it, so it spends less host stack per level than before.

With the host stack cut to 512 KiB, at 192 and at 240 KiB, both pairs gave the same result
on every one of 15 reentry paths but `getter` and `ajvnames`, and every attempt completed or
threw its catchable error, with one exception that both pairs share: `JSON.parse` with a
reviver traps between about 3,615 and 4,500 nested arrays, where the recursive
`JSONRanges::Entry` container is torn down with no stack check. That is older than this
change and is not fixed here.

These are launcher measurements of the guest's own guards. They are not Safari or Firefox
runs and do not show that Angular starts there.

### The interpreter frame floor

The guard counts shadow bytes, and `CLoop::execute` supplies 4,896 of the roughly 5.8 KB
one reentry level spends: an 80-byte block for spilled pointers and a 4,816-byte frame
that is mostly one 8-byte result slot per slow-path call site, with one live at a time.
Those bytes are what stops computed getters at 35 levels and Proxy traps at 29 at
192 KiB, below what Safari's worker stack holds. A compiler upgrade or flag change that
merged the slots would let every reentry path go several times deeper with no source
change of ours.

`scripts/jsc-cloop-frame.ts check <jsc-engine.wasm>` reads that function from a linked
side and fails unless it holds at least 4,896 bytes at every call it makes, which is
where every slow path and every reentry starts. It decodes every instruction and follows
every path through the function's blocks, loops and branches, tracking how far the
exported stack pointer is below its value at entry. It knows two writes: an allocation
of a constant size whose result is kept in a local, and a release through a local that
still holds an allocation's value. Where paths meet it keeps the smaller depth, and a
loop's body is walked again until its entry state holds for every pass. Anything else is
a failure, not a smaller reading: another kind of write to the stack pointer, a release
through a local that was overwritten on some path, a tail call, an unknown instruction,
a missing stack pointer export, or more than one such function.

The two builds differ, which is why the check follows paths and does not match a fixed
prologue. The split side allocates once at entry and releases once at its end: 683 calls,
all at 4,896 bytes. The shared-group side has callees inlined into the loop with their
own frames: 1,050 calls, between 4,896 and 5,344 bytes. The same check bounds the
function's wasm parameters and locals at 328, because a first-tier wasm interpreter keeps
each of them on the host stack. The split side has 293 and the bound is that plus 12%.
The shared-group side has 52.

`scripts/build-engine-jsc.sh` runs the check on every side it produces or reuses, split
and shared-group, before the side gets its receipt. `scripts/jsc-cloop-frame.test.ts`
(`checks/quality-jsc-cloop-frame.json`) holds the accepted shapes, the paths that reach a
call with too little held, the rejected writes and a threshold that fails. If a pin or
toolchain change trips the floor, measure every reentry path again before changing the
number. An escaping function-scope reservation in `CLoop::execute` is the way to restore
the bytes.

## JSC parser reserve

JSC's parser accounting refuses some real package files at the existing browser budgets. `parseStatement` and
`parseAssignmentExpression` each reserve 2048 shadow bytes per call, and one assignment level
really uses about 390. A chain of assignment targets, as generated CommonJS exports have
(`exports.A = exports.B = … = void 0`), therefore stops near 100 targets at a browser's budget.
On an earlier guest, five framework rows failed this way while loading two files: Next 15.5.6's
`dist/compiled/webpack/bundle5.js` and `@babel/types` 7.29.11's
`lib/builders/generated/uppercase.js`.

Chained assignment targets no longer recurse in the parser
([JSC assignment chains](bun-patches/jsc-assignment-chains.md)): a chain of any length holds
three parser frames and three parser reservations, and the code generator stops it, at 230
targets at 192 KiB, so the parser reserve no longer moves that limit. A nest with one assignment
operator per level, such as `a = f(b = f(…))`, keeps upstream's two frames and two reservations
per level. The measurements below predate that change.

`BUN_WASM_JSC_PARSER_RESERVE` is the number of shadow bytes those functions reserve
(`parseStatement`, `parseAssignmentExpression` and its two chain functions). The
default is 2048. The other 20 reserve sites, `parseAwaitExpression`, `StackBounds`, the hard and
soft limits, the exception reserve and every budget do not read it. QuickJS and the host engine
ignore it.

- **Accepted values.** A whole string of one to four decimal digits from 512 through 2048,
  rounded up to a multiple of 16. Unset, empty, a sign, whitespace, a decimal point, trailing
  text, zero, a value outside the range and five or more digits all keep 2048. An invalid value
  is never clamped, because 2048 is the only value with safety evidence on every host.
- **Initialization.** The patched `Parser.cpp` stores the discount from 2048 in one
  zero-initialized variable, so zero-filled side data means 2048 before any initializer runs. Our
  adapter (`crates/bunwasm-jsc/cpp/helpers.cpp`) parses the environment value in the existing
  `JSC::initialize` callback and calls the one setter at most once, before the side's only VM
  exists. The recursive path only loads the variable and subtracts. A guest that changes its own
  environment later changes nothing.
- **Ownership.** Each member has its own engine side data, in a shared-memory group too, so the
  value belongs to one member. A guest `Worker` copies its parent's environment and so inherits the
  value; an explicit `env` reaches only the child.

A larger reserve stops the parser earlier, so it is never less safe and never loads more. That
makes the choice one decision per host family instead of a search: take the largest value on a
64-byte grid from 512 to 1984 at which both real files load with 16 KiB less than the host's
budget, then test only that value on the real host, cold and warm, at the budget and at 1.25
times it. If it fails, that family has no qualified setting and keeps 2048. Nothing lower is
tried, and no other guard or budget moves.

### Host selection

The executor (`web/src/engine-stack-budget.ts`) runs in a worker and sees the user agent and
whether the engine is V8. A worker cannot read touch points, and iPadOS Safari in desktop mode
sends a Macintosh user agent, so the page reports its platform, vendor, and `navigator.maxTouchPoints` in the run request's `stackHost` field.
Both engine policies use that one field. QuickJS retains its positively observed desktop Safari rule above.

| Host | JSC budget | Parser reserve |
| --- | ---: | --- |
| V8 (Chrome, Edge, Node) | 800 KiB | Default |
| Desktop Firefox on Linux: `Firefox/`, `X11` and `Linux`, none of `Android`, `Mobile`, `Tablet`, `FxiOS` | 208 KiB | 960, measured below |
| Desktop Firefox on macOS or Windows | 208 KiB | Default. Not measured |
| macOS Safari | 192 KiB | Default. The measured Apple silicon override below is not selected automatically |
| iPhone, iPad in either user-agent mode, any iOS browser | 192 KiB | Default. Only a native device run could qualify one |
| Android Firefox, a Macintosh Safari identity with no touch-point fact, anything unknown | 192 KiB | Default |

A family without its own passing measurement keeps the default, and the catch-all never carries
a reduced value. Playwright WebKit on Linux and a phone device descriptor on a desktop qualify
nothing.

Safari reports the same user agent on Apple silicon and Intel Macs. The observations used here
do not establish which processor is running, and 832 was measured only on Apple silicon.
WebAssembly leaves the [sign of an arithmetic NaN nondeterministic](https://github.com/WebAssembly/design/blob/main/Rationale.md#support-for-nan-boxing),
so that numerical result cannot authorize a processor-specific setting. Safari therefore keeps
2048. The x86 control below is additional evidence against selecting 832 for every Macintosh
Safari identity.

The executor adds each key only when the request lacks it, independently of the other: an explicit
or empty budget never suppresses the reserve default, and the reverse. Only JSC receives an
automatic parser reserve. Explicit caller environment values remain unchanged.

### Measurements

Taken on November 10, 2026 on one JSC pair: `jsc-engine.wasm` sha256 `49cf6156…2bfdaf`, on the
native launcher and in Firefox 157.0 and Chromium 156 on Linux. The launcher, the site's
decompressed copy and the bytes the browser fetched had that same hash.

The default is unchanged. The deepest chained assignment that loads, counted in a function body's
full parse, is 98 targets at 192 KiB, 105 at 208 and 353 at 800: the same as with the constant
reservation. The compile-only pass allows 107, 114 and 381. 8-bit and 16-bit sources agree.

Capacity follows the value. At 192 KiB, by parser pass:

| Reserve | Assignment, compile | Assignment, full parse | Block, compile | Block, full parse |
| ---: | ---: | ---: | ---: | ---: |
| 2048 | 107 | 98 | 95 | 93 |
| 1024 | 196 | 171 | 157 | 154 |
| 512 | 333 | 268 | 233 | 227 |

Every rejected form gave exactly the default's capacities, 1000 behaved as 1008, and 1009 as 1024.

The two real files, loaded alone from an empty stack on the launcher:

| Budget | Reserve | Babel `uppercase.js` | Next `bundle5.js` |
| ---: | ---: | --- | --- |
| 192 KiB | 2048 | `RangeError` | `RangeError` |
| 208 KiB | 2048 | loads | `RangeError` |
| 192 KiB (208 minus 16) | 960 and below | loads | loads |
| 192 KiB (208 minus 16) | 1024 and above | loads | `RangeError` |
| 176 KiB (192 minus 16) | 832 and below | loads | loads |
| 176 KiB (192 minus 16) | 896 through 1856 | loads | `RangeError` |

So the candidate is 960 for desktop Firefox on Linux. The same rule gives 832 for the 192 KiB
hosts. Desktop Safari on Apple silicon was then tested at 832, as recorded under "Desktop Safari measured override"
below. No phone or tablet run tested it, so every other 192 KiB host keeps 2048.

Firefox 157.0 on Linux at 960, through the repaired sweep: 26 recursion paths and 20 parser
chains, each chain searched so that interior depths run too. At the
host's 208 KiB and at 260 KiB, warm in one page and cold in a fresh browser context per attempt,
every attempted depth completed or threw its expected catchable error and the guest continued.
Chained assignments reach 191 targets in the full parse and 220 in the compile pass at 208 KiB.

Nothing outside the two parser functions moved. On the launcher at 208 KiB, the default and 960
gave identical capacities for getters (36), Proxy traps (32), `JSON.stringify` (39,999), the
reviver (4,500), flattening (329), unary chains (253), both regexp shapes (119), Proxy chains,
bound functions, `join`, `toString` reentry, async and plain recursion. Source shapes that pass
through the two functions rose, as intended: nested blocks 100 to 171, conditional chains 105 to
191. An `await` chain rose by exactly two levels at every budget from 192 to 800 KiB (118 to 120
at 208). This fixed offset is consistent with smaller enclosing parser frames. The number of
those frames is not established by the measurement. The recursive charge and per-level cost of
`parseAwaitExpression` are unchanged.

Chromium 156 on Linux at the default reserve is unchanged: all 46 paths at 800 and at 1000 KiB,
warm and cold, with getters at 142 and chained assignments at 353.

A value belongs to one host family because the host stack behind the guard differs. In Chromium,
1024 at V8's own 800 KiB budget lets the parser nest further than V8's real stack allows: the
same sweep fails five paths there. Nested blocks trap past 518 levels and nested calls past 413
in the full parse, where the default stops them at 330 and 315, and the guest dies with V8's own
`RangeError` where no JavaScript `catch` runs. V8 therefore keeps the default, and the browser
check tries reduced values only at 192 KiB, where the nesting stays below what every browser
already parses at its own budget.

The explicit-value ownership control ran on a shared-group JSC pair in Chromium and Firefox,
through the executor, at 192 KiB. A parent at 1536 kept 125 targets before and after a Worker
child at 1024 reached 171 in the same memory group. The permanent control separates an explicit
guest default of 2048 from an absent key that receives the host's policy. Firefox's host default
is 960, so that child parses deeper than a 1024 parent. A child without an explicit environment
inherits its parent's value. Each case measures the parent again after its child exits.
Capacity actions start in a resumed promise job so the first sample does not retain module-loader
frames that disappear while the child runs. Parent capacity equality remains exact on every engine.

The two original overflow fixtures receive the same literal tuple as the sweep. A cold run
opens a new browser context for each fixture too. A completed probe is rejected if an explicit
requested setting is missing or differs from what the guest reports.

This lowers one guard on one measured host family. It is not a claim that any framework now runs
there: later phases can fail for other reasons. Files loaded through `require` also pass Bun's own
transpiler first. Its recursion has no stack guard in the guest and does not read this setting: a
chain of about 24,000 assignment targets traps the native launcher's 16 MiB host stack there,
before and after this change.

### Desktop Safari measured override

Taken on November 11, 2026 in genuine Safari 26.4 on macOS 26.4 (25E246) on an M1 MacBook Air,
over SafariDriver, with `web/tests/browser-stack-safari.ts`. Playwright WebKit took no part. The
pair is the one CI built from the tree of main at `19dba71ea`, where the setting mechanism landed
(`jsc-engine.wasm` sha256 `e7628017…f7436`). Safari fetched the served side bytes in every run;
this binds the fetched resource, not a hash of the instantiated module. Later engine changes
were not measured there. The 832 value is an experimental override, not an automatic policy.

On the launcher with that pair, 832 is again the largest grid value at which both real files load
at 176 KiB. At 192 KiB the default and 832 give identical capacities for every guard outside the
two parser functions: getters 34, Proxy traps 29, `JSON.stringify` 39,999, the reviver 4,500, unary
chains 237, both regexp shapes 111, Proxy chains 197, bound functions 72, `join` 161, flattening
303, `toString` re-entry 31, async 24,571 and plain recursion. The `await` chain rises by the same
two levels as on Firefox's value.

In Safari at 832: the sweep's 26 recursion paths and 20 parser chains, each chain searched so
that interior depths run too, at the host's 192 KiB and at 240 KiB, cold in a new SafariDriver
session per attempt and warm in a reused page. Every attempted depth completed or threw its
expected catchable error, the guest continued, and both overflow fixtures passed in every run.
Each sweep ran as consecutive parts that together cover every path once, so the shared Mac was
held in short turns; a warm part reuses one page for all of its paths. Three cohorts use the
existing explicit override. The fourth uses a candidate automatic entry that was withdrawn
after review because its processor classifier was not reliable. These measurements do not
enable that entry.

| Deepest that completes in Safari | 192 KiB, 2048 (before) | 192 KiB, 832 | 240 KiB, 832 |
| --- | ---: | ---: | ---: |
| Getters | 34 | 34 | 42 |
| Proxy traps | 29 | 29 | 37 |
| Chained assignments, compile pass and full parse | 107, 98 | 231, 198 | 278, 238 |
| Conditional chains | 106, 98 | 231, 197 | 277, 237 |
| Nested blocks | 95, 93 | 179, 175 | 215, 210 |
| Nested calls | 97, 87 | 193, 160 | 232, 192 |
| Nested functions | 30 | 55 | 66 |

The searched capacities match the launcher's for the same pair and setting. For paths without
a capacity search, the comparison establishes only the same outcome at the harness maximum.
No tested path showed an earlier host-stack cutoff. The default comparison uses 44 completed
rows retained from a timed-out attempt and two resumed rows. The original attempt did not exit
cleanly or reach its final fixtures; the four complete 832 cohorts are separate evidence.

This does not carry to x86. Playwright WebKit 27.2 on Linux x86_64 with worker threads cut to
Darwin's 512 KiB (`ulimit -s 512`), cold, at 832: the host stack ran out before the guard on
nested blocks (95 levels in the full parse and about 172 in the compile pass, against 175 and 179
allowed at 192 KiB) and on nested calls in the full parse (121 against 160). Chained assignments
and conditional chains did not trap. At 2048 on that host the same paths stop at the guard. No
Intel Mac was measured. This Linux control is evidence against extending the value to every
Macintosh Safari identity, not native Intel Safari qualification.

In the diagnostic candidate run at 832, with every phase deadline unchanged, `next dev`, React
Router, SolidStart and TanStack Start start their dev servers where each stopped on the parser
before. These are not product acceptance runs: the candidate policy does not ship. None completes
its lifecycle there. Their first failures move to
later, different limits: page render does not finish in 90 seconds, SolidStart's server compiler
needs 196 KiB for Babel's code generator (a chain of bound-function calls, not the parser), and
Angular stops in Ajv's getter recursion. The budget stays 192 KiB. The existing
`BUN_WASM_JSC_PARSER_RESERVE=832` override remains available for experiments on the measured host;
other hosts are not qualified by these results.

## Historical nested require measurements

This common-loader snapshot predates the native-call dispatcher split, parser
exception preservation and measured desktop Safari policy described above. Its
frame costs and safety conclusions are historical, not current limits.

A CommonJS module that requires another keeps the loader's frames on the stack until
the inner module finishes, so a chain of modules is a recursion path like the others.
On QuickJS every JavaScript frame costs about 320 bytes of the budget, and entering
a module body through `Function.prototype.apply` costs about 510 more.

The loader used to hold six of its own functions between one module body and the
next. It now holds one ([CommonJS loader stack cost](bun-patches/commonjs-loader-stack.md)).
Measured on November 10, 2026 on the native launcher, with the budget set to the
value the browser passes:

| QuickJS budget | Plain calls | Nested `require`, six loader frames | Nested `require`, one loader frame |
| ---: | ---: | ---: | ---: |
| 32 KiB | 97 | 8 | 20 |
| 152 KiB | 501 | 51 | 121 |

One level cost 2,858 bytes before and costs 1,217 now: about 400 for the loader
frame, 510 for the native call and 310 for a trivial module body. About 7 to 8 KiB
of either budget is spent outside the levels, mostly on compiling the next module.

Real packages at 32 KiB, each loaded alone from an empty stack:

| Package | Deepest chain on Node | Six loader frames | One loader frame |
| --- | ---: | --- | --- |
| `prompts` 2.4.2 (loaded by Astro 5.14.1) | 9 modules | `RangeError` | loads, with 7 spare levels |
| `@angular/cli` 20.3.7 `src/utilities/config.js` (through `@angular-devkit/core` and rxjs) | 14 modules | `RangeError`, needs about 54 KiB | `RangeError`, needs 33 to 34 KiB |

At this baseline, Angular failed twelve modules deep in rxjs while compiling the
thirteenth. The native-call cost had not yet been reduced by the dispatcher split,
and 40 KiB was the tested WebKit safety margin. The later native comparison and
45 KiB desktop Safari safety controls above supersede those conclusions.

JSC completes a 512-module chain at 192 KiB before and after, because its
JavaScript-to-JavaScript calls stay on the C-loop stack. Its getter guard was live
in the same run (34 levels). The browser-native engine ignores the budget.

These are launcher measurements of the guest's own guard. They are not a Safari
run and do not show that Astro or Angular start there. The original parser also
replaced a pending overflow with `SyntaxError: missing formal parameter` one level
past the loader's capacity at 40 KiB. The parameter-lookahead correction above
now preserves that overflow's `RangeError` and recovery.

`tests/fixtures/require-chain-stack` holds the line: a child with
`BUN_WASM_STACK_KIB=32` loads a 16-module chain, catches unbounded recursion inside
a nested module, checks that no failed module stayed cached, and loads again.

## Browser-native engine

`bun-browser.wasm` runs guest JavaScript on the host's engine, which keeps its own
guard. Host frames in the runtime's glue are small.

## Measurements

`scripts/measure-stack.py` finds, for each recursion path in `tests/stack-depth.js`,
the deepest nesting that completes and what one level more does: `caught` means a
catchable error, `trap` means the host stack ran out. `web/tests/browser-stack.mjs`
runs the same probe in browser workers with `--measure`, and with `--cold` in a fresh
browser context per attempt.

Measured on 2026-10-16. A number is the deepest nesting that completed; one level
more threw `RangeError` unless marked "trap". "ok" means the console control (every
level swallows the overflow and touches `console.Console`) finished. "WebKit 512" is
Playwright WebKit under `ulimit -s 512` on Linux; "WebKit on macOS" is Playwright WebKit on
an M1 Mac; "first run" uses a fresh page per attempt.

Main paths, before and after:

| Engine, host | Plain | Getter | Proxy trap | `JSON.stringify` | Promise callback | Console |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| QuickJS, wasmtime CLI | trap 1,011 → 501 | trap 703 → 381 | trap 634 → 226 | trap 2,479 → 1,353 | trap 1,020 → 512 | trap → ok |
| QuickJS, native launcher | trap 873 → 13,786 | trap 598 → 10,477 | trap 577 → 6,236 | trap 2,010 → 37,413 | trap 882 → 13,797 | trap → ok |
| QuickJS, Node host | trap 1,835 → 20,685 | trap 1,287 → 15,720 | trap 1,248 → 9,357 | trap 4,983 → 56,138 | trap 1,844 → 20,696 | trap → ok |
| QuickJS, Chromium | trap 923 → 501 | trap 660 → 381 | trap 640 → 226 | trap 2,842 → 1,353 | → 512 | → ok |
| QuickJS, WebKit 512 | trap 644 → 97 | trap 481 → 74 | trap 291 → 44 | trap 1,773 → 256 | → 108 | → ok |
| QuickJS, WebKit 512 first run | trap 286 → 97 | trap 140 → 74 | trap 143 → 44 | trap 483 → 256 | → 108 | → ok |
| QuickJS, WebKit on macOS first run | → 97 | → 74 | → 44 | → 256 | → 108 | → ok |
| JSC, wasmtime CLI | 63,887 → 63,887 | trap 244 → 56 | trap 222 → 54 | 39,999 → 39,999 | 63,896 → 63,896 | ok → ok |
| JSC, native launcher | 63,887 → 63,887 | trap 136 → 731 | trap 126 → 695 | 39,999 → 39,999 | 63,896 → 63,896 | ok → ok |
| JSC, Node host | 63,887 → 63,887 | trap 783 → 892 | trap 737 → 847 | 39,999 → 39,999 | 63,896 → 63,896 | ok → ok |
| JSC, Chromium | 63,887 → 63,887 | trap 389 → 56 | trap 361 → 54 | 39,999 → 39,999 | → 63,896 | → ok |
| JSC, WebKit 512 | 63,887 → 63,887 | trap 82 → 34 | trap 71 → 32 | 39,999 → 39,999 | → 63,896 | → ok |
| JSC, WebKit 512 first run | → 63,887 | trap 57 → 34 | trap 58 → 32 | → 39,999 | → 63,896 | → ok |
| JSC, WebKit on macOS first run | → 63,887 | → 34 | → 32 | → 39,999 | → 63,896 | → ok |
| Browser-native, Node host | 11,403 → over 200,000 | 2,986 → 99,264 | 2,917 → 96,956 | 5,667 → 189,472 | 11,422 → over 200,000 | ok |
| Browser-native, Chromium | 7,811 | 2,959 | 1,692 | 2,611 | 8,519 | ok |
| Browser-native, WebKit 512 | 3,410 | 1,654 | 277 | 39,999 | 3,420 | ok |

Blank "before" cells were not measured. The QuickJS "first run" before row was
measured on a build whose 152 KiB guard does not trip in that tier, so it shows where
the host stack ran out. WebKit rows use the budgets the browser passes off V8
(32 KiB QuickJS, 192 KiB JSC); Chromium uses the defaults. The launcher passes
4096 KiB, and the Node host 6144 KiB on its 32 MB Worker stack, which also deepens the
browser-native engine there. JSC getters on the Node host stop at 892 at any larger
budget: JSC's own `maxPerThreadStackUsage` (5 MB) bounds them there. Otherwise the
browser-native engine does not change; its counts vary by a few percent between runs
as the host JIT tiers up. WebKit on Linux with its default 8 MiB
threads trapped QuickJS after 8,850 plain calls before and catches at 97 after: it
gets the 32 KiB budget because it is JavaScriptCore.

Other QuickJS paths. "Before" is the native launcher; the 152 and 32 KiB columns are
the same on every host with that budget:

| Path | Before | After, 152 KiB | After, 32 KiB | After, launcher (4096 KiB) |
| --- | ---: | ---: | ---: | ---: |
| `JSON.stringify` without replacer | trap 2,010 | 1,356 | 259 | 37,416 |
| `JSON.parse` | trap 2,683 | 1,346 | 249 | 37,406 |
| `JSON.parse` with reviver | trap 2,013 | 862 | 164 | 23,809 |
| Nested array literals in source | trap 243 | 162 | 29 | 4,514 |
| Nested blocks | trap 1,038 | 628 | 116 | 17,456 |
| Nested arrow functions | trap 185 | 126 | 22 | 3,537 |
| Unary operator chain | trap 2,911 | 1,560 | 280 | 43,629 |
| `**` chain | trap 2,912 | 1,560 | 280 | 43,629 |
| Conditional operator chain | trap 2,288 | 936 | 168 | 26,177 |
| `if` chain | trap 1,457 | 781 | 141 | 21,815 |
| Regexp groups (SyntaxError) | trap 1,536 | 452 | 86 | 12,472 |
| Proxy chain without traps | trap 1,700 | 414 | 80 | 11,389 |
| Bound function chain | trap 645 | 352 | 67 | completes at 2,000 |
| Nested arrays to string | trap 222 | 134 | 25 | 3,740 |
| `Array.prototype.flat` | trap 2,149 | 863 | 165 | 23,810 |
| `toString` reentry | trap 258 | 156 | 30 | 4,294 |
| Async recursion | trap 335 | 190 | 36 | 5,238 |

With the 152 KiB default, every path is still caught when wasmtime's stack is cut
to 320 KiB; at 256 KiB plain calls trap. The fixture suites pass with the
conservative browser budgets: `BUN_WASM_STACK_KIB=32` for QuickJS and `192` for JSC. Desktop Firefox
also passes the JSC fixtures at 208 KiB and the 260 KiB margin.

## Reproduce

Build the three artifacts and the launcher, then run these through the machine's
heavy-job wrapper:

```sh
source env.sh
python3 scripts/measure-stack.py --engine quickjs
python3 scripts/measure-stack.py --engine jsc
python3 scripts/measure-stack.py --engine quickjs --host launcher --launcher "$CARGO_TARGET_DIR/release/bun-wasm"
python3 scripts/measure-stack.py --engine quickjs --host node
python3 scripts/measure-stack.py --engine browser --host node plain getter proxy json promise console
python3 scripts/measure-stack.py --engine quickjs --stack-kib 320   # margin: all paths must still be caught
python3 scripts/measure-stack.py --engine quickjs --budget-kib 32     # the budget the browser passes off V8
scripts/test.sh --no-build stack-overflow stack-overflow-console
scripts/test.sh --no-build --engine jsc stack-overflow stack-overflow-console
scripts/test.sh --no-build --engine browser stack-overflow stack-overflow-console
(cd web && bun run build && node tests/browser-stack.mjs --measure)
ENGINES=jsc node web/tests/browser-stack.mjs --measure --cold firefox
bun web/tests/browser-solid-stack.ts                            # actual Firefox/JSC Solid SSR compiler
BUDGET_KIB=192 bun web/tests/browser-solid-stack.ts             # reproduces the old compiler failure
(cd web && ulimit -s 512 && ENGINES=quickjs,jsc node tests/browser-stack.mjs --measure --cold webkit)   # Darwin-sized worker stacks
```

`--wasm <path>` measures another build, such as the parent commit's. `--stack-kib`
sets the host stack independently of the linked shadow stack. Each path's row lists every
attempt it made, with the depth, outcome, exit status, whether it timed out, and the end
of its stderr. Any attempt that traps, times out or prints an invalid transcript fails the
run, whatever the search ends on.

The getter paths and the interpreter frame have their own commands. `ajv` needs an
installed Ajv 8 and is not part of a default sweep:

```sh
python3 scripts/measure-stack.py --engine jsc --budget-kib 192 getter computedgetter ajvnames proxy tostring
python3 scripts/measure-stack.py --engine jsc --budget-kib 192 \
  --ajv-codegen <project>/node_modules/ajv/dist/compile/codegen ajv
bun scripts/jsc-cloop-frame.ts check dist/jsc-engine.wasm
scripts/test.sh --no-build --engine jsc getter-dispatch
```

The parser reserve has its own commands. `--parser-reserve` and `JSC_PARSER_RESERVE` pass a
value unchanged, and `STACK_KIB` sets the budget of a browser sweep. Every probe run prints the
settings its guest was given, and the sweep reports them:

```sh
bun scripts/jsc-parser-reserve.ts controls dist/bun-jsc.wasm                 # the blocking gate's tuples, on the Node host
bun scripts/jsc-parser-reserve.ts capacities dist/bun-jsc.wasm --launcher "$CARGO_TARGET_DIR/release/bun-wasm" 192 192:1024
bun scripts/jsc-parser-reserve.ts threshold dist/bun-jsc.wasm --launcher "$CARGO_TARGET_DIR/release/bun-wasm" \
  --budget-kib 208 --root <project> --file <path in project>=<sha256> --file <path>=<sha256>
python3 scripts/measure-stack.py --engine jsc --budget-kib 208 --parser-reserve 960
(cd web && ENGINES=jsc JSC_PARSER_RESERVE=960 node tests/browser-stack.mjs --measure --cold firefox)
(cd web && ENGINES=jsc STACK_KIB=260 JSC_PARSER_RESERVE=960 node tests/browser-stack.mjs --measure --cold firefox)
(cd web && bun tests/browser-jsc-parser-reserve.ts chromium firefox)          # defaults, executor contract, instances
scripts/test.sh --no-build --engine jsc parser-chain-stack
```

Genuine desktop Safari has its own adapter, because Playwright WebKit is not Safari. Bundle it on
the PC, stage the bundle with `web/serve.ts`, `tests/stack-depth.js`, the two overflow fixtures
and a built site on the Mac, and run it there through the installed queue. `STACK_SLICE` runs
consecutive parts of the paths, so one sweep can be several short turns:

```sh
bun build web/tests/browser-stack-safari.ts --target=bun --outfile=<stage>/stack.js
bun build web/serve.ts --target=bun --outdir=<stage>/web --entry-naming=serve.ts
# On the Mac, in the staged directory, as the command of `mac-queue.ts run`:
ROOT=$PWD/site ENGINES=jsc bun stack.js --measure                                   # the host policy, warm
ROOT=$PWD/site ENGINES=jsc STACK_KIB=240 JSC_PARSER_RESERVE=832 STACK_SLICE=10/12 bun stack.js --measure --cold
```

Playwright also accepts `STACK_SLICE=PART/COUNT` or `FIRST-LAST/COUNT` with `--measure`.
Parts keep the original path order and each cold attempt still opens a fresh context.
Part 1 runs both overflow fixtures after its measurements. Other parts omit those fixtures.
An unset `STACK_SLICE` preserves the full sweep and its output. An explicit `1/1` measures
the full sweep with completion metadata. Selected runs print the selected modes, part count,
settings and a final `stackPartComplete` record only after all their assertions pass.
A successful part is partial evidence. It does not qualify the full sweep.

Only cold measurements may use separate partial invocations. Warm qualification keeps one
continuous context for all paths and fixtures. Use the original unsliced warm command, `1/1`,
or a single full range such as `1-4/4`. Partial warm selections and warm composites from separate
contexts are rejected because their compilation and state histories differ.

Use the existing runner admission for each independent part. Save one invocation per file,
using one browser, engine and settings tuple per collection. For example, run `1/4`, `2/4`,
`3/4` and `4/4` separately, then check their combined coverage:

```sh
ENGINES=jsc STACK_KIB=240 JSC_PARSER_RESERVE=832 STACK_SLICE=2/4 node web/tests/browser-stack.mjs --measure --cold chromium > part-2.jsonl
bun scripts/stack-parts.ts chromium/jsc part-1.jsonl part-2.jsonl part-3.jsonl part-4.jsonl
```

The completion check requires every part and original mode exactly once, both successful
overflow fixtures, matching settings and cold mode, and a completion record in each file.
Missing reports, duplicate parts or modes, failed rows and incomplete runs fail the check.
Run it separately for each required browser, engine, budget and parser reserve tuple.
The checker verifies coverage and recorded assertions; artifact identity and the qualification
matrix remain the caller's responsibility. It starts no work and changes no deadlines.

The `require` path writes its chain of modules into a private scratch directory and
removes it. `--leaf-root` and `--leaf` end the chain in a real installed package, and
the result is how many levels fit above it. A package that cannot load alone is
reported as `refused_at_zero`, not as a capacity of zero:

```sh
python3 scripts/measure-stack.py --engine quickjs --budget-kib 32 require plain
python3 scripts/measure-stack.py --engine quickjs --budget-kib 32 \
  --leaf-root <project with node_modules> --leaf node_modules/prompts/index.js require
python3 scripts/measure-stack.py --engine jsc --budget-kib 192 require getter
scripts/test.sh --no-build require-chain-stack
```

`scripts/measure-require-depth.ts` is a Node preload for the other half of the
question: with `REQUIRE_DEPTH_TARGETS` it prints the CommonJS chain above a named
module the first time it loads, then exits before the application starts.

## Blocking browser check

`checks/browser-guest-quickjs-stack.json` registers the Firefox and Chromium
capacity and cold-recursion checks. The Chromium Processes leg runs both hosts
once against the existing Rust producer's verified site, then runs Firefox at
190 KiB to check the default budget's safety margin. No guest is rebuilt by the
consumer. The WebKit Processes leg exercises the selected 36 KiB policy and
45 KiB margin with explicit desktop page observations and a Safari user agent.
It checks the actual worker environment, retains the original 32 KiB native-call
calibration, and runs all 25 cold probes plus the four original fixtures.
Linux WebKit's injected observations test policy transport, not genuine Safari
qualification. Probe inputs, accepted errors, fixture output and deadlines remain
unchanged. `checks/web-quickjs-stack-policy.json` tests this browser command with
an injected provider without running a guest. Changes to the executor policy,
probe, or fixture select the existing guest producer.

`checks/browser-guest-jsc-parser-reserve.json` registers the parser reserve check on the same
site, in Chromium and Firefox: the host's defaults, the rows of the executor contract, a
differential between two values at one budget, three instances alive at once with different
values, and the served side's hash against the bytes the browser fetched. It needs the JSC pair,
so the same inputs select the JSC producer, and CI tells the check whether that producer was
selected: a selected producer's missing pair fails. The WebKit leg runs the same check on
Playwright WebKit. It selects the macOS Safari row and keeps the default, because no reduced
Safari value is selected automatically. This tests policy transport, not genuine Safari.

The shared-group consumer (`checks/browser-guest-shared-wasm-memory.json`) runs the
parent-and-Worker ownership case in each memory group, beside its existing isolation checks.
The JSC embedding gate (`scripts/jsc-embedding.ts`) runs the tuples on its matched pair: the
default at 192, 208 and 800 KiB, every rejected form, 512, 1024 and 2048, rounding, and each
shipped value at its host's budget. It also runs `parser-chain-stack`, requiring JSC to refuse
the deeper chain. The original 800 KiB control on a 1 MiB Node Worker stack is unchanged.
