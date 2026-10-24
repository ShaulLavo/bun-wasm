## JSC SharedArrayBuffer embedding

Class **Host feature**, original adapters. `crates/bunwasm-jsc/cpp/helpers.cpp`
enables WebKit's native SharedArrayBuffer constructor with `useSharedArrayBuffer`.
The API comes from WebKit `runtime/OptionsList.h` at the revision above. Bun
sets the same option in `src/jsc/bindings/ZigGlobalObject.cpp` at
`9510e74152073d850a18758ca41114d8f214ffa6`. No constructor is copied or aliased.
Cross-guest sharing still throws DataCloneError.

`scripts/jsc-embedding.ts` binds the guest hash to the committed local source,
validated JSC input stamp, native archive hashes, and existing Bun/sysroot build
receipt. Blocking CI selects it for JSC embedding, allocation, build and fixture
inputs. The Rust job reuses its toolchain, sources and dependencies;
it builds JSC once and executes both fixtures against that linked guest in the
Node WASI host. QuickJS and host syntax checks are not JSC execution evidence.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [JSC SharedArrayBuffer embedding](#jsc-sharedarraybuffer-embedding) | Host feature | Original constructor option and source-attributed embedding checks. |

[Ledger scope and pinned revisions](scope.md).
