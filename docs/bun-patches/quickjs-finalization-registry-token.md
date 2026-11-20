## QuickJS weak unregister tokens

Class **Upstream bug**. This changes `quickjs/quickjs.c` from the QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`. Upstream QuickJS-ng holds the token strongly at this revision.

`FinalizationRegistry.prototype.register(target, held, token)` must hold the unregister token weakly (ECMA-262 `CanBeHeldWeakly`, the `[[UnregisterToken]]` cell field). QuickJS-ng duplicated the token into the registry entry and marked it from the registry, so the registry kept the token alive. When the token is the target itself, `registry.register(obj, handle, obj)`, the target could never die and its cleanup never ran. Our runtime modules use that pattern so `close()` can unregister: zlib streams, `HTMLRewriter`, `TextDecoder`, SQLite statements, streams and compression streams that were dropped without `close()` leaked their native resources on QuickJS. 10,000 dropped self-token registrations finalized 0 on QuickJS and all on JSC.

The entry now stores the token without a reference and links itself to the token with a new weak record kind, `JS_WEAK_REF_KIND_FINALIZATION_REGISTRY_TOKEN`, in the same per-object (or per-symbol) weak list that WeakMap, WeakRef and target records use. The registry no longer marks the token. When the token dies, `reset_weak_ref` clears `fre->token` in its first pass and leaves the entry registered; the second pass never touches the entry, because a self token's entry may already have been freed by its own target record. Freeing an entry (target death, `unregister`, registry finalizer) removes the token record unless the token was already cleared. `unregister` compares against the stored token as before, so live tokens, tokens shared by several registrations, and the `TypeError` for tokens that cannot be held weakly are unchanged.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, `js_finrec_*` and `reset_weak_ref`](#quickjs-weak-unregister-tokens) | Upstream bug | Hold the unregister token through a weak record instead of a strong reference. |
| [`crates/bunwasm-engine-quickjs/src/vm.rs`, tests](#quickjs-weak-unregister-tokens) | Upstream bug | Self tokens are collected, unregister semantics hold, cleanup runs once. |
| [`tests/fixtures/finalization-self-token`](#quickjs-weak-unregister-tokens) | Upstream bug | Counts self, separate and symbol token finalizations on every engine. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
