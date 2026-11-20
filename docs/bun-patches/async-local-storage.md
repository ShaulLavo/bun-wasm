# AsyncLocalStorage frames

Class: Adapted implementation.

`crates/bunwasm-runtime/src/js/async_local_storage.ts` adapts the
`AsyncLocalStorage` class and its frame list from Bun's
`src/js/node/async_hooks.ts` at the pinned upstream revision
`9510e74152073d850a18758ca41114d8f214ffa6` (`BUN_COMMIT` in
`scripts/sync-bun.sh`), and is checked against native
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
- The constructor rejects `options` that are `null`, an array or not an
  object with `ERR_INVALID_ARG_TYPE`, as Bun's `validateObject` does.

`AsyncResource` in `crates/bunwasm-runtime/src/js/builtins.js` adapts the
same file's `AsyncResource` at the same revision:
- The constructor rejects a `type` that isn't a string.
- `runInAsyncScope(fn, thisArg, ...args)` calls `fn` with `thisArg` and
  `args` in the context captured when the resource was created, then restores
  the caller's context, also when `fn` throws.
- `bind(fn, thisArg)` validates `fn`. Without `thisArg` the bound function
  passes its own receiver through; with one it is
  `runInAsyncScope.bind(resource, fn, thisArg)`. Its `length` is `fn.length`.
  Bun sets no `asyncResource` property on it (Node does), so neither do we.
- `static bind(fn, type, thisArg)` creates a resource named `type`, then
  `fn.name`, then `bound-anonymous-fn`, and binds `fn` to it.

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
`disable()` replaced the whole context. Before the `AsyncResource` port,
`bind()` returned `fn.bind(resource)` and the static `bind()` returned `fn`
unchanged, so bound callbacks lost their stores. `asyncId()`,
`triggerAsyncId()` and the rest of `node:async_hooks` stay as they were in
`builtins.js`. The `async-local-storage-frames` and `async-resource-bind`
fixtures compare these cases with native Bun.
