// node:crypto Cipheriv, Decipheriv, getCiphers and getCipherInfo. The classes follow Bun's
// src/js/node/crypto.ts (LazyTransform streams over a native handle); the handle's argument
// checks follow Bun's JSCipherConstructor.cpp and JSCipherPrototype.cpp, and the cipher work
// runs on BoringSSL in node_cipher.rs.
(function (internal: BunWasm.Internal) {
  "use strict";
  type Decoder = { encoding: string; write(bytes: Uint8Array): string; end(bytes?: Uint8Array): string };
  type State = {
    handle: NodeCrypto.CipherHandle | undefined;
    decrypt: boolean;
    gcm: boolean;
    tagLength: number | undefined;
    tag: Uint8Array | undefined;
  };
  type Cipher = {
    _options?: unknown;
    _decoder: Decoder | null;
    push(chunk: unknown): boolean;
  };
  type Callback = (error?: Error | null) => void;

  // BoringSSL's cipher table as Bun's getCiphers() lists it.
  const CIPHERS = [
    "aes-128-cbc", "aes-128-cfb", "aes-128-ctr", "aes-128-ecb", "aes-128-gcm", "aes-128-ofb",
    "aes-192-cbc", "aes-192-ctr", "aes-192-ecb", "aes-192-gcm", "aes-192-ofb",
    "aes-256-cbc", "aes-256-cfb", "aes-256-ctr", "aes-256-ecb", "aes-256-gcm", "aes-256-ofb",
    "bf-cbc", "bf-cfb", "bf-ecb", "des-cbc", "des-ecb", "des-ede", "des-ede-cbc", "des-ede3", "des-ede3-cbc",
    "rc2-cbc", "rc4",
  ];

  return function create() {
    const args: NodeCrypto.Args = internal.require("node_crypto_args");
    const { Buffer, coded } = args;
    const native = internal.native.nodeCrypto;
    const states = new WeakMap<object, State>();
    // A cipher dropped before final() frees its BoringSSL context.
    const finalizers = new FinalizationRegistry<number>(id => native.release(id));
    let StringDecoder: (new (encoding: string) => Decoder) | undefined;

    const toBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    function state(cipher: object): State {
      const found = states.get(cipher);
      if (!found) throw coded(new TypeError("Receiver must be an instance of class Cipheriv"), "ERR_INVALID_THIS");
      return found;
    }

    // An int32 option at or above zero, read by value (Bun's tryGetAsInt32).
    function nonNegativeInt32(value: unknown, name: string): number | undefined {
      if (value === undefined || value === null) return undefined;
      if (typeof value === "number" && value === (value | 0) && value >= 0) return value;
      throw args.invalidArgValue(name, value);
    }

    function optionalEncoding(options: unknown): string | undefined {
      if (!options) return undefined;
      const encoding = (options as { encoding?: unknown }).encoding;
      if (encoding === undefined || encoding === null) return undefined;
      args.validateString(encoding, "options.encoding");
      return encoding;
    }

    function init(cipher: object, decrypt: boolean, name: unknown, key: unknown, iv: unknown, options: unknown) {
      args.validateString(name, "cipher");
      const encoding = optionalEncoding(options);
      const keyBytes = args.secretKey(key, encoding);
      const ivBytes = iv === null ? null : args.bytes(iv, "iv");
      const authTagLength = options ? nonNegativeInt32((options as { authTagLength?: unknown }).authTagLength, "options.authTagLength") : undefined;
      const handle = native.cipher(name, decrypt, keyBytes, ivBytes, authTagLength);
      const s: State = { handle, decrypt, gcm: handle.gcm, tagLength: handle.tagLength, tag: undefined };
      states.set(cipher, s);
      // The state is the unregister token: it is reachable only through the WeakMap and
      // holds no reference to the cipher. A cipher that is its own token is never
      // collected on QuickJS, which keeps every dropped cipher and its context alive.
      finalizers.register(cipher, handle.id, s);
    }

    function live(s: State, operation: string): NodeCrypto.CipherHandle {
      if (s.handle === undefined) throw args.invalidState(`Invalid state for operation ${operation}`);
      return s.handle;
    }

    function updateBytes(cipher: object, data: unknown, encoding: unknown): BunWasm.BufferBytes {
      const s = state(cipher);
      const input = args.bytes(data, "data", encoding);
      // Bun's crypto error with no queued OpenSSL error carries no code.
      if (s.handle === undefined) throw new Error("Trying to add data in unsupported state");
      return toBuffer(native.update(s.handle.id, input));
    }

    function finalBytes(cipher: object): BunWasm.BufferBytes {
      const s = state(cipher);
      // Node's CipherBase::Final throws the bare "Invalid state".
      if (s.handle === undefined) throw args.invalidState("Invalid state");
      const { id } = s.handle;
      s.handle = undefined;
      finalizers.unregister(s);
      const { output, tag } = native.final(id);
      if (s.tagLength !== undefined && !s.decrypt) s.tag = tag;
      return toBuffer(output);
    }

    function decoder(cipher: Cipher, encoding: string): Decoder {
      if (!Buffer.isEncoding(encoding)) throw coded(new TypeError(`Unknown encoding: ${encoding}`), "ERR_UNKNOWN_ENCODING");
      StringDecoder ??= (internal.builtin("node:string_decoder") as { StringDecoder: new (encoding: string) => Decoder }).StringDecoder;
      const wanted = new StringDecoder(encoding);
      if (cipher._decoder === null) return (cipher._decoder = wanted);
      // Node's getDecoder (lib/internal/crypto/cipher.js) keeps the first output encoding.
      if (cipher._decoder.encoding !== wanted.encoding) throw coded(new Error("Cannot change encoding"), "ERR_INTERNAL_ASSERTION");
      return cipher._decoder;
    }

    const methods = {
      setAutoPadding(this: Cipher, ap?: unknown) {
        const handle = live(state(this), "setAutoPadding");
        native.setAutoPadding(handle.id, !!ap);
        return this;
      },
      getAuthTag(this: Cipher) {
        const s = state(this);
        if (s.handle !== undefined || s.decrypt || s.tagLength === undefined) throw args.invalidState("Invalid state for operation getAuthTag");
        return Buffer.from(s.tag ?? new Uint8Array(s.tagLength));
      },
      setAuthTag(this: Cipher, tagbuf: unknown, encoding?: unknown) {
        const s = state(this);
        const tag = args.bytes(tagbuf, "buffer", encoding);
        native.setAuthTag(live(s, "setAuthTag").id, tag);
        return this;
      },
      setAAD(this: Cipher, aadbuf: unknown, options?: unknown) {
        const s = state(this);
        const encoding = optionalEncoding(options);
        if (options) nonNegativeInt32((options as { plaintextLength?: unknown }).plaintextLength, "options.plaintextLength");
        const aad = args.bytes(aadbuf, "aadbuf", encoding);
        const handle = live(s, "setAAD");
        if (!handle.gcm) throw args.invalidState("Invalid state for operation setAAD");
        native.setAAD(handle.id, aad);
        return this;
      },
      _transform(this: Cipher, chunk: unknown, encoding: string, callback: Callback) {
        this.push(updateBytes(this, chunk, encoding));
        callback();
      },
      _flush(this: Cipher, callback: Callback) {
        try {
          this.push(finalBytes(this));
        } catch (error) {
          callback(error as Error);
          return;
        }
        callback();
      },
      update(this: Cipher, data: unknown, inputEncoding?: unknown, outputEncoding?: unknown) {
        const result = updateBytes(this, data, inputEncoding);
        if (typeof outputEncoding !== "string" || outputEncoding === "buffer") return result;
        return decoder(this, outputEncoding).write(result);
      },
      final(this: Cipher, outputEncoding?: unknown) {
        const result = finalBytes(this);
        if (typeof outputEncoding !== "string" || outputEncoding === "buffer") return result;
        return decoder(this, outputEncoding).end(result);
      },
    };

    function Cipheriv(this: Cipher, cipher: unknown, key: unknown, iv: unknown, options?: unknown): Cipher | void {
      if (!new.target) return new (Cipheriv as unknown as new (...a: unknown[]) => Cipher)(cipher, key, iv, options);
      init(this, false, cipher, key, iv, options);
      this._options = options;
      this._decoder = null;
    }

    function Decipheriv(this: Cipher, cipher: unknown, key: unknown, iv: unknown, options?: unknown): Cipher | void {
      if (!new.target) return new (Decipheriv as unknown as new (...a: unknown[]) => Cipher)(cipher, key, iv, options);
      init(this, true, cipher, key, iv, options);
      this._options = options;
      this._decoder = null;
    }

    const makeStream = internal.require("crypto_hash_stream");
    const { _transform, _flush, update, final, setAutoPadding, getAuthTag, setAuthTag, setAAD } = methods;
    makeStream(Cipheriv, { _transform, _flush });
    makeStream(Decipheriv, { _transform, _flush });
    for (const [target, own] of [[Cipheriv, { setAutoPadding, getAuthTag, setAAD, update, final }], [Decipheriv, { setAutoPadding, setAuthTag, setAAD, update, final }]] as const) {
      for (const [name, value] of Object.entries(own)) {
        Object.defineProperty(target.prototype, name, { value, writable: true, configurable: true, enumerable: true });
      }
    }

    function getCipherInfo(nameOrNid: unknown, options?: unknown) {
      if (typeof nameOrNid === "number") args.validateInt32(nameOrNid, "nameOrNid");
      else if (typeof nameOrNid !== "string") throw args.argType("nameOrNid", "string or number", nameOrNid);
      let keyLength: number | undefined;
      let ivLength: number | undefined;
      if (options !== undefined) {
        args.validateObject(options, "options");
        const { keyLength: wantedKey, ivLength: wantedIv } = options as { keyLength?: unknown; ivLength?: unknown };
        if (wantedKey !== undefined) keyLength = args.validateInt32(wantedKey, "keyLength");
        if (wantedIv !== undefined) ivLength = args.validateInt32(wantedIv, "ivLength");
      }
      return native.cipherInfo(nameOrNid, keyLength, ivLength);
    }

    return {
      Cipheriv,
      Decipheriv,
      createCipheriv: function createCipheriv(cipher: unknown, key: unknown, iv: unknown, options?: unknown) {
        return new (Cipheriv as unknown as new (...a: unknown[]) => Cipher)(cipher, key, iv, options);
      },
      createDecipheriv: function createDecipheriv(cipher: unknown, key: unknown, iv: unknown, options?: unknown) {
        return new (Decipheriv as unknown as new (...a: unknown[]) => Cipher)(cipher, key, iv, options);
      },
      getCiphers: function getCiphers() {
        return CIPHERS.slice();
      },
      getCipherInfo,
    };
  };
});
