# JSC VM teardown aborts on WASI

Status: Approved. Owner: Engines. Not started.

## Problem

Destroying a JSC VM on the WASI build aborts. `JSGlobalContextRelease` on the
last reference runs `VM::~VM`, `Heap::shutDown` and `lastChanceToFinalize`. The
sweep destroys a `PropertyTable`, whose atom key's `StringImpl::~StringImpl`
calls `AtomStringImpl::remove`, which hits a release assertion and aborts:

```
0: abort
1: WTFCrashWithInfoImpl(int, char const*, char const*, unsigned int)
2: WTF::AtomStringImpl::remove(WTF::AtomStringImpl*)
3: WTF::StringImpl::~StringImpl()
4: WTF::StringImpl::destroy(WTF::StringImpl*)
5: JSC::PropertyTable::~PropertyTable()
6: JSC::PropertyTable::destroy(JSC::JSCell*)
7: JSC::MarkedBlock::Handle::specializedSweep<...>
...
13: JSC::MarkedBlock::Handle::lastChanceToFinalize()
16: JSC::Heap::shutDown()
17: JSC::VM::~VM()
18: JSGlobalContextRelease
```

It does not depend on resizable buffers: it reproduces at WebKit
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb` with `jsc/webkit-wasi.patch` and a
context that only evaluates a small script. Found 2026-11-16 while finishing
bun-wasm PR 888 (JSC resizable ArrayBuffer backing).

The guest never destroys its VM today, so nothing ships broken. It matters as
soon as anything tears a JSC VM down: per-Worker VMs, an embedder that recycles
contexts, or a test that checks teardown accounting.
`tests/native/jsc-resizable-backing.cpp` keeps its context alive for this reason.

Not yet ruled out: the atom string table that `remove` checks may differ from
the one current at teardown (a per-thread table that WASI's thread emulation
resets or never installs), or the VM's identifier table may already be torn
down when the sweep runs. Start by reading the assertion in
`Source/WTF/wtf/text/AtomStringImpl.cpp` `remove` and `Thread::current()`'s
atom table on WASI.

## Reproduction

Save as `repro.cpp`:

```cpp
#include "config.h"
#include "APICast.h"
#include "JSContextRef.h"
#include "JSStringRef.h"
#include "WASIResizableBufferTesting.h"
#include <cstdio>

namespace JSC {
WASIResizableBufferTestHooks* wasiResizableBufferTestHooks { nullptr };
}

int main()
{
    auto context = JSGlobalContextCreate(nullptr);
    auto text = JSStringCreateWithUTF8CString("globalThis.x = {a: 1, b: 'two'}; new Uint8Array(4);");
    JSEvaluateScript(context, text, nullptr, nullptr, 0, nullptr);
    JSStringRelease(text);
    JSGlobalContextRelease(context);
    std::puts("Deterministic native backing controls passed");
    return 0;
}
```

Build a JSC prebuild (`JSC_BUILD_DIR=<dir> scripts/build-jsc.sh`), then compile,
link, finalize and run it with the native control driver, which reuses the
prebuild's compile and link flags:

```sh
source env.sh
export JSC_BUILD_DIR=<dir>
# repro.ts:
#   import { nativeBackingControl } from "<repo>/scripts/jsc-resizable-native.ts";
#   nativeBackingControl({ root: "<repo>", prebuild: process.env.JSC_BUILD_DIR!, scratch: "<scratch>", source: "<path>/repro.cpp" });
bun repro.ts
```

Expected: the marker line, exit 0. Observed: `wasmtime exited 134` with the
backtrace above. Removing `JSGlobalContextRelease` makes it pass.

## Done when

The reproduction exits 0 and `tests/native/jsc-resizable-backing.cpp` releases
its context and checks accounting after teardown again.
