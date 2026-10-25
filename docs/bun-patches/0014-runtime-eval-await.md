## 0014 run-time await hooks

File `0014-wasm-record-await-spans-for-run-time-AsyncLocalStora.patch`.
Class **Host feature**. Upstream is Bun
`9510e74152073d850a18758ca41114d8f214ffa6`.

Upstream paths are `src/js_parser/lexer.rs`, `src/js_parser/lib.rs`,
`src/js_parser/parse/{mod,parse_prefix,parse_stmt,parse_suffix}.rs`, and
`src/js_printer/lib.rs`. The lexer saves and restores `prev_token_end` with
its other backtracking state. The scoped parser collector records await
operands, labeled for-await bodies, and nonempty direct-eval argument lists.
It shares a module-level restoration guard with patch 0010, preserving the
previous collector on return or unwind. With patch 0008's hooks enabled,
the printer wraps a direct eval's argument in `__bunwasm_evalSource` without
replacing the callee. Parsing otherwise stays unchanged.

### Empty-call contract

The printer only hooks calls with arguments. The collector uses the same
`!list_loc.list.is_empty()` condition. `eval()`, `eval( )`, and calls with only
comments or newlines have no source argument to transform and produce no eval
edits. This avoids the old same-offset closer-before-opener pair without
changing sorting for adjacent or nested nonempty spans. The previous Rust test
incorrectly expected an empty call to gain a helper invocation. The existing
`run_time_source_hooks` test now checks both the agreed empty-call contract and
nested, awaited, and Unicode-prefix controls. The collector restoration guard,
UTF-16 conversion, and nonempty ordering are unchanged.

### Original host adapters

The following are **original adapters**, not copied upstream implementations:

- `crates/bunwasm-transpiler/src/lib.rs` scans run-time source and returns
  UTF-16 insertion offsets. All original text, comments, line breaks, and
  sourceURL text remain in the host's string. Function arguments are parsed
  together but receive separate edit lists.
- `crates/bunwasm-cli/src/main.rs`,
  `crates/bunwasm-runtime/src/{engine,natives,transpiler}.rs`, and
  `web/src/engine-host.js` bridge the edit lists to the browser engine. The
  existing async-context mechanism is reused, not replaced.
- `crates/bunwasm-runtime/src/js/{function.ts,builtins.js,runtime.d.ts}` connect
  generated functions and VM scripts to that bridge. The typed constructor
  adapter preserves main's import rewriting, validation, and module origins.
- `tests/fixtures/async-local-storage-eval/` exercises the runtime entries.
  Its sole native discovery owner is `checks/native-runtime-eval-await.json`.
  The Rust unit test remains owned by the workspace Rust quality gate.

The adapters reuse patch 0008's await/loop hooks and add direct-eval argument
wrappers. Indirect eval is not covered. No allocator, Promise propagation, or
async-context mechanism change belongs to this record. `Module#_compile` needs
the separate PR102 implementation before its evalScript entry can benefit.
This source feature and its unit regressions do not establish that Next's
HTTP 500/E696, development navigation, or HMR failure is fixed. Current guest
and application acceptance remain separate gates.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0014](#0014-run-time-await-hooks) | Host feature | Collect run-time await and nonempty eval spans; reuse the host's existing hooks. |
| Original adapters and tests above | Host feature | Bridge UTF-16 edits to existing engine entry points and check their contracts. |

[Ledger scope and pinned revisions](scope.md).
