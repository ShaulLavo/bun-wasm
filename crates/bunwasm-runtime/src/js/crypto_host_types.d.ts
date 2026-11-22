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
  /** The WebCrypto provider's key records, shared with node:crypto, structuredClone and postMessage. */
  interface CryptoHostBridge {
    isKey(value: unknown): value is CryptoKey;
    record(key: CryptoKey): { algorithm: CryptoAlgorithm; extractable: boolean; usages: KeyUsage[]; key: JsonWebKey };
    buffer(data: unknown): Uint8Array<ArrayBuffer>;
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
