declare namespace BunWasm {
  type CryptoMaterialField = "kty" | "crv" | "k" | "n" | "e" | "d" | "p" | "q" | "dp" | "dq" | "qi" | "x" | "y";
  type CryptoImportData = object & Partial<Record<CryptoMaterialField, unknown>> & { ext?: boolean; key_ops?: Iterable<string>; alg?: string; use?: string };
  interface CryptoParameters {
    name: string;
    public?: CryptoKey;
    hash?: string | Algorithm;
    length?: number;
    namedCurve?: string;
    modulusLength?: number;
    publicExponent?: Uint8Array;
    iterations?: number;
    tagLength?: number;
    iv?: unknown;
    counter?: unknown;
    additionalData?: unknown;
    label?: unknown;
    salt?: unknown;
    info?: unknown;
  }
  type CryptoAlgorithm = (string & { readonly public?: undefined }) | CryptoParameters;
  type HostBytes = Uint8Array<ArrayBuffer>;
  /** The host engine's own Web Crypto (browser engine only), captured before the runtime's globals. */
  interface HostCrypto {
    digest(algorithm: string, data: HostBytes): Promise<ArrayBuffer>;
    importKey(format: "raw", data: HostBytes, algorithm: object, extractable: boolean, usages: KeyUsage[]): Promise<CryptoKey>;
    importKey(format: "jwk", data: JsonWebKey, algorithm: object, extractable: boolean, usages: KeyUsage[]): Promise<CryptoKey>;
    encrypt(algorithm: object, key: CryptoKey, data: HostBytes): Promise<ArrayBuffer>;
    decrypt(algorithm: object, key: CryptoKey, data: HostBytes): Promise<ArrayBuffer>;
    sign(algorithm: object, key: CryptoKey, data: HostBytes): Promise<ArrayBuffer>;
    verify(algorithm: object, key: CryptoKey, signature: HostBytes, data: HostBytes): Promise<boolean>;
  }
  interface Native {
    readonly hostCrypto?: HostCrypto;
  }
  type CryptoHostImport =
    | { format: "raw"; data: HostBytes; algorithm: object; usages: KeyUsage[] }
    | { format: "jwk"; data: JsonWebKey; algorithm: object; usages: KeyUsage[] };
  /** A validated encrypt, decrypt, sign or verify call: crypto.js builds it before any computation. */
  interface CryptoOperationPlan {
    readonly op: "encrypt" | "decrypt" | "sign" | "verify";
    readonly a: CryptoParameters & { saltLength?: number };
    readonly r: { algorithm: CryptoParameters & { hash?: string | { name: string } }; type: "secret" | "private" | "public"; key: JsonWebKey };
    readonly out: { hash?: { name: string }; tagLength?: number; length?: number };
    readonly key: CryptoKey;
  }
  /** Host work and the input it used, which a guest fallback computes from. */
  interface HostOffload<T> {
    readonly promise: Promise<T>;
    readonly input: HostBytes;
  }
  interface HostCompute {
    /** The rejection of host work whose key the host refused: the guest computes from its input. */
    readonly refused: Error;
    digest(name: string, data: HostBytes): HostOffload<ArrayBuffer> | undefined;
    crypt(plan: CryptoOperationPlan, data: HostBytes): HostOffload<ArrayBuffer> | undefined;
    sign(plan: CryptoOperationPlan, data: HostBytes): HostOffload<ArrayBuffer> | undefined;
    verify(plan: CryptoOperationPlan, signature: HostBytes, data: HostBytes): HostOffload<boolean> | undefined;
  }
  type HostComputeFactory = (
    host: HostCrypto,
    helpers: { buffer(data: unknown): HostBytes; decode(data: unknown): HostBytes },
  ) => HostCompute;
  /** The WebCrypto provider's key records, shared with node:crypto, structuredClone and postMessage. */
  interface CryptoHostBridge {
    isKey(value: unknown): value is CryptoKey;
    record(key: CryptoKey): { algorithm: CryptoAlgorithm; extractable: boolean; usages: KeyUsage[]; key: JsonWebKey };
    encode(data: unknown): string;
    decode(data: unknown): Uint8Array<ArrayBuffer>;
    /** A structured clone of a provider key; undefined for any other value. */
    cloneKey(value: unknown): CryptoKey | undefined;
    /** A provider key's record as JSON for another realm; undefined for any other value. */
    serializeKey(value: unknown): string | undefined;
    /** The key a serializeKey record describes, in this realm; throws DataCloneError for a bad record. */
    deserializeKey(record: string): CryptoKey;
  }
  interface Internal {
    readonly crypto: CryptoHostBridge;
  }
}
