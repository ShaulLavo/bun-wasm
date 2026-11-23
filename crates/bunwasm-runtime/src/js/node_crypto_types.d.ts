declare namespace NodeCrypto {
  type Bytes = Uint8Array;
  type Buffer = BunWasm.BufferBytes;
  type Input = string | ArrayBuffer | ArrayBufferView;
  type Callback<T> = (error: Error | null | undefined, value?: T) => void;
  interface Args {
    Buffer: BunWasm.BufferConstructor & { alloc(size: number): Buffer; concat(chunks: readonly Uint8Array[]): Buffer };
    argType(name: string, expected: string, value: unknown): TypeError;
    invalidArgValue(name: string, value: unknown, reason?: string): TypeError;
    coded<E extends Error>(error: E, code: string): E & { code: string };
    validateString(value: unknown, name: string): asserts value is string;
    validateObject(value: unknown, name: string): asserts value is object;
    validateFunction(value: unknown, name: string): asserts value is Function;
    validateBoolean(value: unknown, name: string): asserts value is boolean;
    validateInt32(value: unknown, name: string, min?: number, max?: number): number;
    isBufferSource(value: unknown): value is ArrayBuffer | ArrayBufferView;
    /** Bun's getArrayBufferOrView: a string in `encoding`, or the bytes of a buffer source. */
    bytes(value: unknown, name: string, encoding?: unknown): Bytes;
    /** Bun's getEncodingDefaultBuffer and StringBytes::encode. */
    encodeOut(bytes: Bytes, encoding: unknown): Buffer | string;
    /** Bun's KeyObject::prepareSecretKey. */
    secretKey(key: unknown, encoding?: string): Bytes;
    /** crypto.hash's argument checks; returns the encoding to digest with ("buffer" canonical). */
    hashOutputEncoding(algorithm: unknown, input: unknown, outputEncoding: unknown): string;
    /** An OpenSSL error as Bun's createCryptoError builds it. */
    opensslError(packed: string, library: string, reason: string, code: string): Error;
    invalidState(message: string): Error;
    operationFailed(message: string): Error;
  }
  interface CipherHandle {
    id: number;
    gcm: boolean;
    tagLength: number | undefined;
  }
  type CipherInfo = { mode?: string; name: string; nid: number; blockSize?: number; ivLength?: number; keyLength: number };
}

declare namespace BunWasm {
  interface Native {
    nodeCrypto: {
      cipherInfo(nameOrNid: string | number, keyLength?: number, ivLength?: number): NodeCrypto.CipherInfo | undefined;
      cipher(name: string, decrypt: boolean, key: Uint8Array, iv: Uint8Array | null, authTagLength?: number): NodeCrypto.CipherHandle;
      update(id: number, data: Uint8Array): Uint8Array;
      final(id: number): { output: Uint8Array; tag: Uint8Array };
      setAAD(id: number, aad: Uint8Array): void;
      setAuthTag(id: number, tag: Uint8Array): void;
      setAutoPadding(id: number, padding: boolean): void;
      release(id: number): void;
      liveCiphers(): number;
      dhGroup(name: string): Uint8Array | null;
      dhParameters(bits: number, generator: number): Uint8Array | null;
      dhCheck(prime: Uint8Array, generator: Uint8Array): number;
      dhGenerate(prime: Uint8Array, generator: Uint8Array, privateKey: Uint8Array | null): [Uint8Array, Uint8Array] | null;
      dhSecret(prime: Uint8Array, generator: Uint8Array, privateKey: Uint8Array | null, peer: Uint8Array): Uint8Array | number | null;
      ecdhCurve(name: string): number;
      ecdhGenerate(nid: number): [Uint8Array, Uint8Array | null] | null;
      ecdhPoint(nid: number, point: Uint8Array, form: number): Uint8Array | number;
      ecdhPrivate(nid: number, privateKey: Uint8Array): [Uint8Array, Uint8Array | null] | number;
      ecdhSecret(nid: number, privateKey: Uint8Array | null, publicKey: Uint8Array | null, peer: Uint8Array): Uint8Array | number;
      x25519(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array | null;
      primeCheck(candidate: Uint8Array, checks: number): number;
      primeOptions(bits: number, add: Uint8Array, rem: Uint8Array | null): number;
      primeGenerate(bits: number, safe: boolean, add: Uint8Array | null, rem: Uint8Array | null): Uint8Array | null;
    };
  }
  interface Internal {
    require(name: "node_crypto_args"): NodeCrypto.Args;
    require(name: "crypto_hash_stream"): (target: { prototype: object }, methods?: object) => void;
  }
}
