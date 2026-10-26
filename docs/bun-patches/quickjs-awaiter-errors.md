## QuickJS await PromiseResolve errors

Class **Upstream bug**. This changes `quickjs/quickjs.c` from the QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`.

`js_async_function_resume` rejected the outer async-function promise when `js_promise_resolve` failed at an await. A throwing `constructor` getter therefore bypassed a catch around that await. The function now resumes the suspended frame with the pending ordinary exception, matching the existing async-generator await path. Uncatchable engine errors keep the original termination path.

The correction is original bun-wasm source. It copies no new upstream implementation and adds no public engine API.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, async await](#quickjs-await-promise-resolve-errors) | Upstream bug | Deliver an ordinary PromiseResolve exception at the suspended await so local catch and finally blocks can handle it. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
