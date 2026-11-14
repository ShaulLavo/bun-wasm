# SpiderMonkey module body entry

This host feature patches Mozilla revision
`a5df22d986d4b626f771b4f8885241941601c35c` through
`spidermonkey/spidermonkey-wasi.patch`. Every addition is guarded by
`__wasi__ && BUNWASM_EMBED`.

| Upstream path | Local change and reason |
| --- | --- |
| `js/src/builtin/ModuleObject.cpp`, `ModuleObject.h` | Add an initially clear cyclic-record bit and accessors. Synthetic records have no bit. |
| `js/src/vm/Interpreter.cpp` | Mark a module after prologue, debugger and coverage checks, immediately before first dispatch. Generator resumes retain the first entry's bit. |
| `js/src/vm/PortableBaselineInterpret.cpp` | Mark a module beside the existing PBL entry counter after entry checks and coverage. Restart paths have already left this entry path. |
| `js/public/Modules.h`, `js/src/vm/Modules.cpp` | Declare and implement `JS::GetModuleEvaluationInfo`. Read record state and an existing engine error report without allocation, JavaScript, GC, unwrapping or property access. Only `JSMSG_OVER_RECURSED` sets `overRecursed`. |

The caller retains a live, unwrapped module record throughout the query. The
returned struct owns no GC pointers. New through linked records are Unevaluated,
evaluating records are Pending, and evaluated records are Fulfilled or Failed.
Synthetic records report Fulfilled with both flags false. A body failure keeps
its entry bit, including an engine stack overflow inside the body. User errors
with the same text do not count as engine over-recursion.

`tests/module-evaluation-info.cpp` in the native crate is an original JSAPI
control. It uses the unchanged standalone setup on both tiers, checks pending
top-level await and resumption, retained failures, GC, synthetic records and
pending-exception preservation. The native producer stages and hashes the
patched public header with the other exported headers. No cache eviction,
promise-ownership repair, quota or tier change is part of this patch.
