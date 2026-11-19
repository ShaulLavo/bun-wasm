// node:async_hooks AsyncLocalStorage, adapted from Bun's src/js/node/async_hooks.ts (see
// docs/bun-patches/async-local-storage.md). The engine's async-context slot holds the innermost
// Frame of a persistent linked list: each Frame binds one storage to a value and points at the
// frame it was pushed onto, so a captured context is one reference sharing its tail with every
// other capture, and getStore() walks at most one frame per storage.
(function (internal: BunWasm.Internal) {
  "use strict";
  const { native } = internal;
  const apply = Reflect.apply;
  type Storage = object;

  // SameValue, as Node's primordial ObjectIs: a userland Object.is patch must not reach run().
  function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return a !== 0 || 1 / (a as number) === 1 / (b as number);
    return a !== a && b !== b;
  }

  class Frame {
    readonly storage: Storage;
    readonly value: unknown;
    readonly prev: Frame | undefined;
    // Storages disable() exited while this frame was current. A lookup starting here (or at a
    // frame later pushed on top, which inherits the mask) sees no binding for them; lookups that
    // only pass through from a newer frame are unaffected. This is Node deleting the key from
    // the current frame object: holders of that frame and later copies lose the binding.
    masked: Storage[] | undefined;
    constructor(storage: Storage, value: unknown, prev: Frame | undefined, masked: Storage[] | undefined) {
      this.storage = storage;
      this.value = value;
      this.prev = prev;
      this.masked = masked;
    }
  }

  // Bumped whenever disable() masks a frame in place, so run() can tell that the chain it
  // installed changed under it even though its identity did not.
  let frameMutations = 0;

  function get(): Frame | undefined {
    const frame = native.getAsyncContext();
    return frame instanceof Frame ? frame : undefined;
  }

  function set(frame: Frame | undefined): void {
    native.setAsyncContext(frame);
  }

  function isMasked(frame: Frame | undefined, storage: Storage): boolean {
    return frame !== undefined && frame.masked !== undefined && frame.masked.indexOf(storage) !== -1;
  }

  function unmask(masked: Storage[] | undefined, storage: Storage): Storage[] | undefined {
    if (masked === undefined) return undefined;
    const rest = masked.filter((entry) => entry !== storage);
    if (rest.length === 0) return undefined;
    return rest.length === masked.length ? masked : rest;
  }

  // The innermost frame binding `storage` at or below `frame`, ignoring masks.
  function find(frame: Frame | undefined, storage: Storage): Frame | undefined {
    for (let f = frame; f !== undefined; f = f.prev) {
      if (f.storage === storage) return f;
    }
    return undefined;
  }

  function lookup(start: Frame | undefined, storage: Storage): Frame | undefined {
    return isMasked(start, storage) ? undefined : find(start, storage);
  }

  // A new binding on top of `head`; what was visible from `head` stays visible.
  function push(head: Frame | undefined, storage: Storage, value: unknown): Frame {
    return new Frame(storage, value, head, head === undefined ? undefined : unmask(head.masked, storage));
  }

  // `frame` with the binding of `storage` removed: frames above it are copied (other captures
  // may share them), the tail below it is shared, so a chain never holds two bindings of one
  // storage and a capture never keeps a shadowed value alive.
  function without(frame: Frame | undefined, storage: Storage): Frame | undefined {
    const found = find(frame, storage);
    return found === undefined ? frame : copyUntil(frame!, found, found.prev);
  }

  // Copies [from, stop) onto tail. The new head carries `from`'s mask; a deeper frame's own mask
  // describes lookups that start there and is not inherited.
  function copyUntil(from: Frame, stop: Frame, tail: Frame | undefined): Frame | undefined {
    if (from === stop) {
      if (tail === undefined || tail.masked === from.masked) return tail;
      return new Frame(tail.storage, tail.value, tail.prev, from.masked);
    }
    const copied: Frame[] = [];
    for (let f = from; f !== stop; f = f.prev!) copied.push(f);
    for (let i = copied.length - 1; i >= 0; i--) {
      tail = new Frame(copied[i].storage, copied[i].value, tail, copied[i].masked);
    }
    return tail;
  }

  function invalidArgType(name: string, type: string, value: unknown): TypeError {
    const message = `The "${name}" argument must be of type ${type}. Received ${internal.describe(value)}`;
    return Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
  }

  // Node parity: dispose() is enterWith(previousStore), which on a fresh storage leaves a
  // binding to undefined rather than removing it like run().
  class RunScope {
    #storage: AsyncLocalStorage;
    #previousStore: unknown;
    #disposed = false;
    constructor(storage: AsyncLocalStorage, store: unknown) {
      this.#storage = storage;
      this.#previousStore = storage.getStore();
      storage.enterWith(store);
    }
    dispose(): void {
      if (this.#disposed) return;
      this.#disposed = true;
      this.#storage.enterWith(this.#previousStore);
    }
    [Symbol.dispose](): void {
      this.dispose();
    }
  }

  class AsyncLocalStorage {
    #defaultValue: unknown = undefined;
    #name: string | undefined = undefined;

    constructor(options?: { defaultValue?: unknown; name?: unknown }) {
      if (options === undefined) return;
      if (options === null || typeof options !== "object" || Array.isArray(options)) throw invalidArgType("options", "object", options);
      this.#defaultValue = options.defaultValue;
      if (options.name !== undefined) this.#name = `${options.name}`;
    }

    static bind(fn: unknown, ...args: unknown[]) {
      if (typeof fn !== "function") throw invalidArgType("fn", "function", fn);
      const boundArgs: unknown[] = [null, fn];
      return apply(Function.prototype.bind, this.snapshot(), boundArgs.concat(args));
    }

    static snapshot() {
      const context = get();
      return (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => internal.runInContext(context, fn, undefined, args);
    }

    get name(): string {
      return this.#name || "";
    }

    enterWith(store: unknown): void {
      set(push(without(get(), this), this, store));
    }

    exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
      const runArgs: unknown[] = [undefined, callback];
      return apply(this.run, this, runArgs.concat(args)) as R;
    }

    run<R>(store: unknown, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
      const prior = get();
      const bound = find(prior, this);
      const beforeValue = bound !== undefined && !isMasked(prior, this) ? bound.value : this.#defaultValue;
      // Node short-circuits an unchanged value: no enterWith and no restore, so an enterWith()
      // inside the callback survives past run().
      if (sameValue(beforeValue, store)) return apply(callback, undefined, args);
      const mutations = frameMutations;
      const frame = push(bound === undefined ? prior : copyUntil(prior!, bound, bound.prev), this, store);
      set(frame);
      try {
        return apply(callback, undefined, args);
      } finally {
        set(restored(prior, frame, mutations, this, beforeValue));
      }
    }

    disable(): void {
      const top = get();
      if (top === undefined || lookup(top, this) === undefined) return;
      top.masked = top.masked === undefined ? [this] : top.masked.concat([this]);
      frameMutations++;
    }

    getStore(): unknown {
      const start = get();
      if (start === undefined || isMasked(start, this)) return this.#defaultValue;
      const frame = find(start, this);
      return frame === undefined ? this.#defaultValue : frame.value;
    }

    withScope(store: unknown): RunScope {
      return new RunScope(this, store);
    }

    // Node internals; Bun keeps them as no-ops.
    _enable(): void {}
    _propagate(): void {}
  }

  // The frame run() leaves behind. Node exits through enterWith(prior), a fresh frame object:
  // a later disable() reaches continuations captured after run() returned but not ones captured
  // before it, so `prior` itself must not become current again. When the callback ran
  // enterWith() or disable(), keep what else it installed and rebind this storage to the value
  // getStore() returned on entry, going by value because frames may have been copied since.
  function restored(prior: Frame | undefined, frame: Frame, mutations: number, storage: Storage, beforeValue: unknown): Frame | undefined {
    const head = get();
    const untouched = mutations === frameMutations && (head === frame
      || (head !== undefined && head.prev === frame.prev && head.storage === storage && head.masked === frame.masked));
    if (!untouched) return push(without(head, storage), storage, beforeValue);
    return prior === undefined ? undefined : new Frame(prior.storage, prior.value, prior.prev, prior.masked);
  }

  return { AsyncLocalStorage };
});
