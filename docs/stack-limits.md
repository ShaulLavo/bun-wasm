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
The launcher still catches every path with a budget one and a half times as large
(6144 KiB). On the Node host the stack was shrunk instead: with the 6144 KiB default
and a 21 MB Worker stack (32/1.5), all 25 paths still threw or completed on QuickJS
and JSC.
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
with a `RangeError` while compiling TypeScript's own library, which Next loads
to read `next.config.ts`. The deepest point of that parse is a tree of nested
call and array expressions with no statement open, so it is expression
nesting, which still recurses. This is a launcher measurement of the guest's
own guard at the unchanged budget, not a Safari run.

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

JSC's plain JavaScript calls stay in the C-loop and already throw. Getters, Proxy
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
sets the host stack independently of the linked shadow stack.

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
