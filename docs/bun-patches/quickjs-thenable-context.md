## QuickJS thenable async context

Class **Host feature**. This changes `quickjs/quickjs.c` from the QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`.

The existing host async-context support captures frames for promise reactions, but the native thenable job omitted its frame. `js_promise_resolve_function_call` now lends the current frame to `JS_EnqueueJob` as a fourth argument after reading `then`. The enqueue operation duplicates it with the other job arguments. `js_promise_resolve_thenable_job` enters that frame. It restores the previous frame on every completion path, including resolving-function allocation failure and rejection after a throwing callable. This preserves the original thenable, resolving functions, evaluation order, and error behavior.

The change is original bun-wasm host integration. It copies no new upstream implementation and adds no public engine API.
The native contract test is owned by `bunwasm-engine-quickjs`, so the split engine crate discovers and executes the produced-library check.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, thenable jobs](#quickjs-thenable-async-context) | Host feature | Capture the post-getter async frame for native thenable jobs and restore it on every exit. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
