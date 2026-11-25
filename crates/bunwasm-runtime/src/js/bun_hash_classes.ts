// Bun.MD4, MD5, SHA1, SHA224, SHA256, SHA384, SHA512 and SHA512_256: one-algorithm
// hashers with a static `byteLength` and `hash()`, as in Bun's bun.d.ts and native
// Bun 1.4.4. Each instance digests once.
(function (internal: BunWasm.Internal) {
  "use strict";
  type State = { chunks: Uint8Array[]; done: boolean };
  const CLASSES = [["MD4", "md4", 16], ["MD5", "md5", 16], ["SHA1", "sha1", 20], ["SHA224", "sha224", 28], ["SHA256", "sha256", 32], ["SHA384", "sha384", 48], ["SHA512", "sha512", 64], ["SHA512_256", "sha512-256", 32]] as const;

  const typeError = (message: string, code = "ERR_INVALID_ARG_TYPE") => Object.assign(new TypeError(message), { code });

  // Strings hash as UTF-8, buffers and in-memory Blobs as their bytes; native Bun rejects
  // everything else, including a file-backed Blob.
  function input(data: unknown): Uint8Array {
    if (typeof data === "string") return internal.native.utf8Encode(data);
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return internal.toUint8(data);
    if (data instanceof Blob) {
      if (data._isLazy()) throw typeError("File blob cannot be used here");
      return data._bytes();
    }
    throw typeError("input must be a string, ArrayBuffer, ArrayBufferView or Blob");
  }

  // A buffer target receives the digest and is returned; "buffer" returns a Buffer; anything else
  // names an encoding.
  function output(bytes: Uint8Array, target: unknown, byteLength: number): unknown {
    if (target === undefined) return bytes;
    if (ArrayBuffer.isView(target) || target instanceof ArrayBuffer) {
      if (target.byteLength < byteLength) throw typeError(`TypedArray must be at least ${byteLength} bytes`);
      internal.toUint8(target).set(bytes.subarray(0, byteLength));
      return target;
    }
    const { Buffer } = internal.require("buffer");
    const encoding = String(target);
    if (encoding === "buffer") return Buffer.from(bytes);
    if (!Buffer.isEncoding(encoding)) throw typeError(`Unknown encoding: ${encoding}`, "ERR_INVALID_ARG_VALUE");
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding);
  }

  function define(name: string, algorithm: string, byteLength: number) {
    const states = new WeakMap<object, State>();
    const digestBytes = (chunks: Uint8Array[]): Uint8Array => internal.native.nodeDigest(algorithm, internal.concatBytes(chunks));
    const live = (self: object, action: string): State => {
      const state = states.get(self);
      if (!state) throw Object.assign(new TypeError(`Expected this to be an instance of ${name}`), { code: "ERR_INVALID_THIS" });
      if (state.done) throw Object.assign(new Error(`${name} hasher already digested, create a new instance to ${action}`), { code: "ERR_INVALID_STATE" });
      return state;
    };
    const Hasher = function (this: object) {
      if (new.target === undefined) throw Object.assign(new TypeError(`${name} constructor cannot be invoked without 'new'`), { code: "ERR_ILLEGAL_CONSTRUCTOR" });
      states.set(this, { chunks: [], done: false });
    };
    Object.defineProperty(Hasher, "name", { value: name });
    Object.defineProperty(Hasher, "byteLength", { value: byteLength, enumerable: true });
    Object.defineProperty(Hasher, "hash", {
      value: function hash(data: unknown, target?: unknown) { return output(digestBytes([input(data)]), target, byteLength); },
      writable: true, configurable: true,
    });
    const methods = {
      get byteLength() { return byteLength; },
      update(this: object, data: unknown) {
        live(this, "update").chunks.push(input(data).slice());
        return this;
      },
      digest(this: object, target?: unknown) {
        const state = live(this, "digest again");
        // A bad target throws before the hasher is used up, so the caller can retry, as in Bun.
        const result = output(digestBytes(state.chunks), target, byteLength);
        state.done = true;
        return result;
      },
    };
    // Bun lists byteLength, digest and update, then constructor.
    const prototype: object = Hasher.prototype;
    Reflect.deleteProperty(prototype, "constructor");
    const { byteLength: length, digest, update } = Object.getOwnPropertyDescriptors(methods);
    Object.defineProperties(prototype, { byteLength: length, digest, update });
    Object.defineProperty(prototype, "constructor", { value: Hasher, writable: true, configurable: true });
    return Hasher;
  }

  return Object.fromEntries(CLASSES.map(([name, algorithm, byteLength]) => [name, define(name, algorithm, byteLength)]));
})
