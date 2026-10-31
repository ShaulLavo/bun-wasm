## VM context global binding

Class **Host feature**, an **original adapter** in
`crates/bunwasm-runtime/src/js/builtins.js`. The behavioral comparison is Node
26.12.1's public `node:vm` contract; no upstream implementation is copied.

`vmModule.runWith` gives an extensible context a non-enumerable `globalThis`
binding to itself when neither the context nor its prototype chain supplies one.
This keeps context-global writes on the supplied object and preserves the binding
across reuse. Existing caller data and accessor descriptors remain authoritative.
A frozen or otherwise non-extensible context without a binding keeps the existing
fallback behavior rather than being mutated or causing setup to fail.

The adapter is still not a separate realm or security sandbox. Other unresolved
names and top-level `this` fall back to the host global, and non-extensible
contexts cannot gain the new own binding. `scripts/vm-context.test.ts` covers
these boundaries and the outer-global pollution regression.

## VM context scripts without `with`

Class **Host feature**, an **original adapter** in
`crates/bunwasm-runtime/src/js/vm_context.ts`, the `vm-context` goal of
`crates/bunwasm-transpiler/src/prepare.rs` and `prepareContextScript` in
`source_prepare.ts`. It uses patch 0018's visit-pass reference records
([runtime source preparation](0018-runtime-source-preparation.md)). No upstream
implementation is copied.

Pinned Hermes rejects `with` statements, so on Hermes `runWith` does not compile
the `with` runner. The parser prepares the context code once per distinct
source. Every reference that no declaration in the source binds becomes a member
of a scope parameter, `typeof` operands read a view that yields `undefined`,
direct calls and template tags use `(0, scope.f)`, shorthand values use computed
data-property keys, and the final top-level expression statement returns its value. The scope
name is the first `__bunwasm_vm` variant no scope in the source declares.
Spans are the original text, so escaped identifiers stay escaped. Computed keys
keep `__proto__`, including escaped spellings, as an own data property instead
of an object-literal prototype setter. Parse errors, strict-mode early errors,
`import`, `export` and a top-level `return` throw `SyntaxError` before the
context is read. Constant reassignment remains a runtime error; only its
specifically recorded diagnostic may survive the visit pass.

The scope is a Proxy that resolves each name when it is evaluated: the context,
own or inherited, first, then the host global, otherwise `ReferenceError`.
Closures that outlive the call and names added during the call stay live.
Getters, setters and thrown values propagate unchanged. A write to a frozen
binding throws `TypeError` in strict code and fails silently in sloppy code.
QuickJS, JSC and the browser host keep the `with` runner unchanged.

Accepted limits, pinned by `scripts/vm-context.test.ts`:

- Only the final top-level expression statement completes; `if (a) { 1 }` and
  `x; var y = 1` return `undefined`.
- A bare call of a context function receives `this` undefined, where `with`
  passes the context.
- Top-level `var` and function declarations stay local to the call, even when
  the context has the same name.
- The binding a write targets is chosen when the write happens, after its
  right-hand side runs.
- Writes to names nobody has go to the host global, also from strict code.
- Host lexical globals, `Symbol.unscopables`, direct `eval` seeing the context,
  top-level `arguments`, and `return` nested in a top-level block are not modeled.
- Stack columns on the first line shift by the scope header, and later columns
  on a line shift by earlier insertions. Lines are exact.

`tests/fixtures/vm-context-prepare.json` holds the source-to-edits records. The
`prepare.rs` unit test checks them against Bun's parser, and the host test
replays them through the lowered JavaScript. The host test stands in host
JavaScript for Hermes, so it proves the lowering and the scope lookups, not the
engine. `tests/hermes/vm-context.cts` is the engine check.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/builtins.js`, VM context global binding](#vm-context-global-binding) | Host feature | Bind eligible contexts to their own global writes without replacing caller descriptors. Original adapter. |
| [`vm_context.ts`, `prepare.rs` goal `vm-context` and patch 0018 visit records](#vm-context-scripts-without-with) | Host feature | Run context code on Hermes, which has no `with`, through parser-found free references and a live context-first scope. Original adapter over Bun 9510e74152073d850a18758ca41114d8f214ffa6's binder. |

[Ledger scope and pinned revisions](scope.md).
