declare namespace BunWasm {
  type CryptoMaterialField = "kty" | "crv" | "k" | "n" | "e" | "d" | "p" | "q" | "dp" | "dq" | "qi" | "x" | "y";
  // These fields are copied before the provider validates either the format or data.
  type CryptoImportData = object & Partial<Record<CryptoMaterialField, unknown>> & { ext?: boolean; key_ops?: Iterable<string>; alg?: string; use?: string };
  type CryptoExportData = JsonWebKey | ArrayBuffer;
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
  type GeneratedCryptoKey = (CryptoKey & { readonly privateKey?: undefined }) | CryptoKeyPair;
  interface CryptoHostProvider {
    generateKey(a: CryptoAlgorithm, extractable: boolean, usages: Iterable<KeyUsage>): Promise<GeneratedCryptoKey>;
    importKey(format: unknown, data: CryptoImportData, a: CryptoAlgorithm, extractable: boolean, usages: Iterable<KeyUsage>): Promise<CryptoKey>;
    exportKey(format: unknown, key: CryptoKey): Promise<CryptoExportData>;
    // Missing data and extra arguments reach the native WebIDL validator unchanged.
    sign(a: CryptoAlgorithm, key: CryptoKey, ...input: [data?: BufferSource, ...extra: (BufferSource | undefined)[]]): Promise<ArrayBuffer>;
    verify(a: CryptoAlgorithm, key: CryptoKey, ...input: [signature?: BufferSource, data?: BufferSource, ...extra: (BufferSource | undefined)[]]): Promise<boolean>;
    encrypt(a: CryptoAlgorithm, key: CryptoKey, ...input: [data?: BufferSource, ...extra: (BufferSource | undefined)[]]): Promise<ArrayBuffer>;
    decrypt(a: CryptoAlgorithm, key: CryptoKey, ...input: [data?: BufferSource, ...extra: (BufferSource | undefined)[]]): Promise<ArrayBuffer>;
    deriveBits(a: CryptoAlgorithm, key: CryptoKey, length: number | null): Promise<ArrayBuffer>;
    deriveKey(a: CryptoAlgorithm, key: CryptoKey, derived: CryptoAlgorithm, extractable: boolean, usages: Iterable<KeyUsage>): Promise<CryptoKey>;
    wrapKey(format: unknown, key: CryptoKey, wrappingKey: CryptoKey, a: CryptoAlgorithm): Promise<ArrayBuffer>;
    unwrapKey(format: unknown, wrapped: BufferSource, key: CryptoKey, a: CryptoAlgorithm, unwrapped: CryptoAlgorithm, extractable: boolean, usages: Iterable<KeyUsage>): Promise<CryptoKey>;
  }
  interface Native {
    readonly subtleCrypto?: CryptoHostProvider | null | false | 0 | "";
  }
  interface CryptoHostBridge {
    isKey(value: unknown): value is CryptoKey;
    isWasmKey(value: unknown): value is CryptoKey;
    record(key: CryptoKey): { algorithm: CryptoAlgorithm; extractable: boolean; usages: KeyUsage[]; key: JsonWebKey };
    rememberKey(key: CryptoKey, material: CryptoImportData): void;
    buffer(data: unknown): Uint8Array<ArrayBuffer>;
    encode(data: unknown): string;
    decode(data: unknown): Uint8Array<ArrayBuffer>;
    supportsAlgorithm(name: string): boolean;
    crypt(mode: "decrypt", a: CryptoAlgorithm, key: CryptoKey, bytes: BufferSource, usage: "unwrapKey"): ArrayBuffer;
  }
  interface Internal {
    readonly crypto: CryptoHostBridge;
  }
}
