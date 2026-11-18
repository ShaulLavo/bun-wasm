# AsyncLocalStorage frames

Class: Adapted implementation.

`crates/bunwasm-runtime/src/js/async_local_storage.ts` adapts the
`AsyncLocalStorage` class and its frame list from Bun's
`src/js/node/async_hooks.ts` at revision
`44d770399a790f41d8b0d5c4b6c59e10b23b9074`, and is checked against native
Bun 1.4.4. The engine's async-context slot holds the innermost frame of a
linked list. Each frame binds one storage to a value and points at the frame
it was pushed onto. `disable()` marks the storage as removed on the current
frame only, which is what Node does when it deletes the key from the current
frame object.

The adapted behavior:
- `defaultValue` and `name` options.
- `run()` skips straight to the callback when the value is unchanged, compared
  with SameValue, so `NaN` works and a patched `Object.is` has no effect.
- `run()` restores by value after an `enterWith()`, `withScope()` or
  `disable()` inside the callback.
- `withScope()`.
- `bind()` rejects a value that isn't a function with `ERR_INVALID_ARG_TYPE`.

Local changes:
- `$getInternalField($asyncContext, 0)` and `$putInternalField` become the
  runtime's `native.getAsyncContext` and `native.setAsyncContext`, which every
  engine already carries across promise reactions, timers, ticks and I/O.
- `$apply` becomes `Reflect.apply`, and `exit()` passes its arguments through
  `Reflect.apply` rather than a spread. Arguments never pass through a deleted
  `Array.prototype[Symbol.iterator]`.
- `validateFunction` and `validateObject` become a local `ERR_INVALID_ARG_TYPE`
  built from `internal.describe`.
- Bun's debug ids, assertions and `setAsyncHooksEnabled` call are left out.
- A context value that isn't one of these frames counts as empty.

Before this, the context was a frozen `Map` copied on every `run()`, and
`disable()` replaced the whole context. `AsyncResource` and the rest of
`node:async_hooks` stay in `builtins.js` unchanged. The
`async-local-storage-frames` fixture compares these cases with native Bun.
