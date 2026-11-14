# QuickJS RegExp.test result allocation

## Source and classification

| Source | Pin | Class |
| --- | --- | --- |
| `third_party/rquickjs-sys/quickjs/quickjs.c`, regexp helpers | QuickJS-ng 0.16.2 shipped in rquickjs-sys 0.13.0; local base `412f340a44fac7c0e32795aacbc1bab84ee9c9db` | Host feature |
| `scripts/quickjs-regexp-test.test.ts`, `scripts/fixtures/quickjs-regexp-test.*` | Original native embedding and semantic controls | Original adapter |

The upstream regexp matcher and its bytecode are unchanged. This patch changes
only the private regexp helpers in `quickjs.c`. There is no public C API change.

## Change

`RegExp.prototype.test` formerly called the regular execution helper, converted
its array or null result to a Boolean, and freed the array. Successful matches
allocated substrings, capture entries, named groups and indices that the caller
immediately discarded. The private execution helper now accepts a test-only
mode. After matching and updating `lastIndex`, that mode returns an immediate
success value through the existing cleanup path.

The test dispatch still reads `exec` exactly once. It recognizes the actual
native intrinsic with `JS_IsCFunction`, including an intrinsic obtained from
another realm. Its private native call preserves the interrupt poll, native
stack guard, active function frame, argument and intrinsic realm. Proxies,
bound functions and custom methods retain the original call and return-value
validation. A noncallable `exec` retains the native fallback.

Input conversion, receiver checks, `lastIndex` conversion and writes, matcher
errors, interruption and the capture/temporary-register allocation remain in
the original implementation. The buffer still uses `lre_get_alloc_count`.
Direct `exec` and the other regexp methods continue constructing full results.
The patch does not cache capture buffers or change literal compilation.

## Verification

```sh
source env.sh
bun test scripts/quickjs-regexp-test.test.ts
```

The discovered native probe links the matching native QuickJS archive from the
existing producer checkpoint, checking every vendored C/header input. A local
standalone run compiles the vendored engine if no matching archive exists. It
compares 83 semantic traces with the retained pre-change engine and Node traces.
Cases include custom and noncallable `exec`, getters, input and index coercion,
global/sticky state, nonwritable indices, Unicode, captures, backreferences,
named groups, indices, reentry, proxies, bound functions and invalid receivers.
The native embedding also checks foreign-realm errors and state, the active
`exec` frame, native stack refusal, matcher interruption, allocation failure,
recovery and complete allocator teardown. Its C fixture directly uses the
engine's C API and default allocator callbacks.

The baseline has **20 existing differences from Node** in these traces:
`test` passes an unconverted input to a custom method and looks up `exec` before
input conversion. Those differences are retained separately in
`quickjs-regexp-test.baseline.json` and `quickjs-regexp-test.node.json`.
The check requires the candidate to preserve each baseline row and the same
20 differences. This performance patch does not correct that ordering.
