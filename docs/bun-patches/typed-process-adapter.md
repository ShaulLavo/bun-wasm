## Typed process adapter

`crates/bunwasm-runtime/src/js/process.ts` is our original adapter, not copied Bun or Node code.
Its reference APIs are Bun's `src/bun.js/bindings/BunProcess.cpp` at
`d71508d31edf06765c12adf0df137ef531539f68` and Node's `lib/internal/process` APIs.
The migration pins our JavaScript at `ac43127c85addabed7e0c2a4883247ae074e858c`.
No upstream implementation was imported or changed.

The process and writer prototype-only emitter allocations keep their original objects and constructor-call
positions. Typed results of the existing Object.assign calls describe the later fields. A queued
writer flush captures its exact Failure object. Shared failure stays present during callbacks,
including reentrant appends, and resets only after normal callback return. A throw still aborts
reset and leaves subsequent writes attached to the old failure without scheduling another flush.

Except for the separately recorded [nonblocking stdin adapter](process-stdin-identity.md), other executable AST nodes match the pinned original. The five immediate erased bitwise
operand bridges keep unknown inputs and the original coercion and exceptions. They neither
store a narrowed value nor call Number. Two erased map non-null proofs follow the existing
has/set initialization and traversal of that same map's numeric keys. Environment descriptors
and Symbol keys retain raw unknown values; the worker hook retains its method-call receiver.
Only the hook input declaration changes, not worker serialization or worker implementations.
The held worker-owned GuestProcess view is not broadened into the new process factory's type.

`scripts/runtime-process.test.ts` reverses each approved executable change and checks the
original AST hash, strict directive and token positions. The frozen pre-change reader is restored only for this guard; its obsolete one-shot-read behavior is replaced by dedicated stdin controls. Its original/converted factory controls
cover own-key order, descriptors, constructor-call state, reentrancy, thrown callbacks, errors,
exit coercion, environment hooks and signals. `runtime-ts-process` pins the real guest adapter;
native reference differences remain evidence. The stdin fixture now resumes after its pause check and expects unreadable state at EOF.

Recovery keeps the same runtime source and emitted bytes. Additional controls reject callback
snapshots, reset-on-throw, callback receiver changes, and Symbol value coercion. They exercise
falsy thrown values and environment setters as well as getter results. Compiler rejection
checks require the intended diagnostic, including the factory's unknown stored exitCode.
Native pipe controls are separate from the unchanged guest fixture. Native Bun and Node lack
its unconditional terminal methods on redirected stdout, reject environment accessors and
Symbol keys, and mark stdin unreadable at EOF. Bun also reports no SIGIO listener when the
prototype method registers that alias. These observations do not grant native parity or
turn the original failing native-public fixture into a successful control.

## Integration after PR168

The accepted adapter and focused controls at
`ee3ec9474b1ce049b502cceb9c954fd9a3a29775` are preserved. The process declarations
are added to the current runtime contracts; the worker environment hook still
accepts raw unknown values. Existing console and worker declarations stay intact.
`checks/runtime-process.json` gives the source controls to the runtime owner.
`checks/native-runtime-ts-process.json` gives the unchanged guest fixture to the
native owner. Signal tests retain their existing automatic web discovery.

Historical guests were built at `d312330564b435efa5497499f7b8621f043d2967`.
Their recovery qualification is not evidence for this integration's source.
Existing CI producers qualify new source without a separate product build.
The native public controls remain RED at `stdout.getWindowSize is not a function`.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Typed process adapter](#typed-process-adapter) | Host feature | Original process adapter with typed same-object construction, captured writer failures and focused behavior controls. No upstream implementation copied or patched. |

[Ledger scope and pinned revisions](scope.md).
