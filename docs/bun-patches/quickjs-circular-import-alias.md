## QuickJS circular import alias resolution

Class **Upstream bug**. This changes `quickjs/quickjs.c` from the QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`.

`js_get_local_export_var_ref1` shared its cycle-detection state with recursive export-name resolution. A valid cyclic imported re-export with two indirect hops therefore looked like an unresolvable cycle and failed with `circular import: binding 'Fragment' is not resolvable`. The helper now uses `js_resolve_export` to give that lookup a fresh state while retaining its own state to terminate genuine unresolved alias cycles.

The correction is original bun-wasm source. It copies no new upstream implementation, adds no public engine API, and leaves direct exports and evaluation-time TDZ behavior unchanged.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, circular import aliases](#quickjs-circular-import-alias-resolution) | Upstream bug | Resolve multi-hop imported re-export cycles without losing genuine-cycle termination. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
