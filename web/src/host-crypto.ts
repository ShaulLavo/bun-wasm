// The host's own Web Crypto, captured before bootstrap replaces `crypto`. The runtime's
// provider validates every SubtleCrypto call itself and hands only the bulk computation of a
// supported operation here (crates/bunwasm-runtime/src/js/crypto_host_compute.ts). Each host
// promise is tracked, so pending crypto keeps the program alive.
type Bytes = Uint8Array<ArrayBuffer>;
type Track = <T>(promise: Promise<T>) => Promise<T>;

export interface HostCrypto {
  digest(algorithm: string, data: Bytes): Promise<ArrayBuffer>;
  importKey(format: "raw", data: Bytes, algorithm: object, extractable: boolean, usages: KeyUsage[]): Promise<CryptoKey>;
  importKey(format: "jwk", data: JsonWebKey, algorithm: object, extractable: boolean, usages: KeyUsage[]): Promise<CryptoKey>;
  encrypt(algorithm: object, key: CryptoKey, data: Bytes): Promise<ArrayBuffer>;
  decrypt(algorithm: object, key: CryptoKey, data: Bytes): Promise<ArrayBuffer>;
  sign(algorithm: object, key: CryptoKey, data: Bytes): Promise<ArrayBuffer>;
  verify(algorithm: object, key: CryptoKey, signature: Bytes, data: Bytes): Promise<boolean>;
}

const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
const captured = subtle && {
  digest: subtle.digest.bind(subtle),
  importKey: subtle.importKey.bind(subtle),
  encrypt: subtle.encrypt.bind(subtle),
  decrypt: subtle.decrypt.bind(subtle),
  sign: subtle.sign.bind(subtle),
  verify: subtle.verify.bind(subtle),
};

function importKey(
  track: Track,
  format: "raw" | "jwk",
  data: Bytes | JsonWebKey,
  algorithm: object,
  extractable: boolean,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (!captured) throw new Error("no host SubtleCrypto");
  const a = algorithm as Algorithm;
  return track(format === "jwk"
    ? captured.importKey("jwk", data as JsonWebKey, a, extractable, usages)
    : captured.importKey("raw", data as Bytes, a, extractable, usages));
}

/** The host's Web Crypto for the guest, or undefined where the host has none (an insecure context). */
export function hostCrypto(track: Track): HostCrypto | undefined {
  if (!captured) return undefined;
  const host = captured;
  return {
    digest: (algorithm, data) => track(host.digest(algorithm, data)),
    importKey: (format: "raw" | "jwk", data: Bytes | JsonWebKey, algorithm: object, extractable: boolean, usages: KeyUsage[]) =>
      importKey(track, format, data, algorithm, extractable, usages),
    encrypt: (algorithm, key, data) => track(host.encrypt(algorithm as Algorithm, key, data)),
    decrypt: (algorithm, key, data) => track(host.decrypt(algorithm as Algorithm, key, data)),
    sign: (algorithm, key, data) => track(host.sign(algorithm as Algorithm, key, data)),
    verify: (algorithm, key, signature, data) => track(host.verify(algorithm as Algorithm, key, signature, data)),
  };
}
