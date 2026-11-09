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
budget fit the host: a budget larger than the host stack allows traps as before. The browser executor (`web/src/engine-stack-budget.ts`) passes 32 KiB to
QuickJS on WebKit and unmeasured hosts. V8 and desktop Firefox keep QuickJS's
152 KiB default. Desktop Firefox uses a measured 208 KiB JSC budget. In WebKit on
the Mac with every function in its first tier, getters,
`JSON.stringify` and `toString` reentry trap at 50 KiB, and the fixture's
`JSON.stringify` traps at 45 KiB while building its RangeError, so the room there is
about 43 to 47 KiB. At 40 KiB (1.25 times 32) every path and fixture still passes.
Linux WebKit under `ulimit -s 512` has more room (54 KiB for its tightest path).
Desktop Firefox was measured with all 25 recursion cases below, each in a fresh
browser context. At both 152 KiB and a 190 KiB margin, every case completed or
threw a catchable exception and continued. Both stack-overflow fixtures also
passed at 190 KiB. Giving Firefox the smaller WebKit budget needlessly rejects
React Router's ordinary CommonJS dependency loading. Firefox on Android remains unmeasured and keeps the smaller budget. Firefox on iOS
still uses WebKit and keeps it too. Unknown Firefox platforms also keep the
smaller budget.

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

Remaining gaps are visible in the original browser-stack probe. Unary operator
chains and the noncapturing-group and lookahead regexp cases still trap at
200,000 levels in Chrome. Blocks and conditional expressions now throw instead.
This is not a claim that every parser or regexp shape is safe. The extra accounting
can reduce native-path nesting capacities on other hosts. Firefox's original two
stack fixtures and Linux WebKit under a 512 KiB host stack pass; no new Darwin or
iOS measurement is claimed.

## Nested require

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

The Angular chain still does not fit in 32 KiB. It now fails twelve modules deep in
rxjs while compiling the thirteenth. The native call into each module body is the
largest cost left, and removing it needs a different wrapper shape on every engine.
A larger budget is not the answer: 40 KiB is the measured ceiling for WebKit above.

JSC completes a 512-module chain at 192 KiB before and after, because its
JavaScript-to-JavaScript calls stay on the C-loop stack. Its getter guard was live
in the same run (34 levels). The browser-native engine ignores the budget.

These are launcher measurements of the guest's own guard. They are not a Safari
run, and they do not show that Astro or Angular start there: later phases of both
have never run at 32 KiB. An overflow that lands in QuickJS's parser can also
surface as a `SyntaxError` instead of a `RangeError`. The unchanged loader reported
`SyntaxError: missing formal parameter` one level past its capacity at 40 KiB.

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
consumer. Changes to the executor policy, probe, or fixture select that producer.
