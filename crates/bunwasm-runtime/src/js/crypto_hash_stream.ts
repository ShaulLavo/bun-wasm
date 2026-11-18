// node:crypto Hash and Hmac are Transform streams, as in Node's
// lib/internal/streams/lazy_transform.js: the stream state is only created the first
// time a stream member reads it, so plain update()/digest() use pays nothing.
(function (internal: BunWasm.Internal) {
  "use strict";
  type Callback = (error?: Error | null) => void;
  type Streamable = {
    _options?: unknown;
    _writableState?: { decodeStrings: boolean };
    update(data: unknown, encoding?: string): unknown;
    digest(): unknown;
    push(chunk: unknown): boolean;
  };
  type StreamModule = { Transform: { prototype: object } };

  return function makeHashStream(Hash: { prototype: object }): void {
    const { Transform } = internal.builtin("node:stream") as unknown as StreamModule;
    function LazyTransform() {}
    Object.setPrototypeOf(LazyTransform.prototype, Transform.prototype);
    for (const name of ["_readableState", "_writableState", "_transformState"]) {
      Object.defineProperty(LazyTransform.prototype, name, {
        get(this: Streamable) {
          Reflect.apply(Transform as unknown as Function, this, [this._options]);
          if (this._writableState) this._writableState.decodeStrings = false;
          return Reflect.get(this, name);
        },
        set(this: object, value: unknown) {
          Object.defineProperty(this, name, { value, enumerable: true, configurable: true, writable: true });
        },
        enumerable: true,
        configurable: true,
      });
    }
    Object.setPrototypeOf(Hash.prototype, LazyTransform.prototype);
    const methods = {
      _transform(this: Streamable, chunk: unknown, encoding: string, callback: Callback) {
        this.update(chunk, encoding);
        callback();
      },
      _flush(this: Streamable, callback: Callback) {
        this.push(this.digest());
        callback();
      },
    };
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(Hash.prototype, name, { value, writable: true, configurable: true });
    }
  };
})
