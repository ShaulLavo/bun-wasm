declare namespace BunWasm {
  interface Native {
    readonly engine: "quickjs" | "jsc" | "host";
    /** Optional slot 18: 0/0 dequeues; modes 0/1/2 publish DEFAULT/IGNORE/HANDLE, 3 raises. */
    hostSignal(signal: number, disposition: number): number;
    globMatch(pattern: string, path: string): boolean;
    globScan(pattern: string, cwd: string, dot: boolean, absolute: boolean, followSymlinks: boolean,
      throwErrorOnBrokenSymlink: boolean, onlyFiles: boolean, followMatchedSymlinks?: boolean): string[];
  }

  type GlobScanOptions = Parameters<Native["globScan"]> extends [pattern: string, ...options: infer Options] ? Options : never;

  interface Internal {
    readonly native: Native;
    require(name: "path"): { resolve(...paths: string[]): string };
  }
  type EventListener = (...args: unknown[]) => void;
  interface NodeEmitter {
    on(this: object, event: string | symbol, listener: EventListener): unknown;
    once(this: object, event: string | symbol, listener: EventListener): unknown;
    prependListener(this: object, event: string | symbol, listener: EventListener): unknown;
    prependOnceListener(this: object, event: string | symbol, listener: EventListener): unknown;
    removeListener(this: object, event: string | symbol, listener: EventListener): unknown;
    removeAllListeners(this: object, event?: string | symbol): unknown;
    emit(this: object, event: string | symbol, ...args: unknown[]): boolean;
    listenerCount(this: object, event: string | symbol): number;
    listeners(this: object, event: string | symbol): EventListener[];
    rawListeners(this: object, event: string | symbol): EventListener[];
    eventNames(this: object): (string | symbol)[];
    getMaxListeners(this: object): number;
    setMaxListeners(this: object, count: number): unknown;
  }
  interface Internal {
    require(name: "events"): { new(): NodeEmitter; call(target: object): void; prototype: NodeEmitter };
    require(name: "structured_clone"): { structuredClone(value: unknown, options?: unknown): unknown };
    messagePortRefs: number;
    isMarkedAsUntransferable?: (value: unknown) => boolean;
  }
}

declare const process: { cwd(): string };
declare const Buffer: unknown;
declare function setImmediate(callback: () => void): unknown;

declare namespace BunWasm {
  interface Internal { web: { Response: { _setUrl(response: Response, url: string): void } } }
  type HTMLHandlerKind = "element" | "comments" | "text" | "doctype" | "end" | "endTag";
  interface HTMLStepEvent { handler: number; kind: HTMLHandlerKind }
  interface HTMLStep { output: Uint8Array; event?: HTMLStepEvent }
  interface HTMLTokenValues {
    tagName: string; setTagName: void; selfClosing: boolean; canHaveContent: boolean; namespaceURI: string;
    removed: boolean; attributes: [string, string][]; getAttribute: string | null; hasAttribute: boolean;
    setAttribute: void; removeAttribute: void; before: void; after: void; replace: void; prepend: void;
    append: void; setInnerContent: void; remove: void; removeAndKeepContent: void; onEndTag: number | undefined;
    text: string; setText: void; lastInTextNode: boolean; name: string | null; setName: void;
    publicId: string | null; systemId: string | null;
  }
  interface Native {
    htmlValidateSelector(selector: string): void;
    htmlCreate(registrations: string): number;
    htmlStep(id: number, action: "write" | "end" | "resume", bytes: Uint8Array): HTMLStep;
    htmlToken<K extends keyof HTMLTokenValues>(id: number, action: K, value: string, html: boolean, extra?: string | number): HTMLTokenValues[K];
    htmlClose(id: number): void;
  }
}

declare namespace BunWasm {
  interface CertificateData {
    raw: Uint8Array;
    subject?: string; issuer?: string;
    subjectEntries: [string, string][]; issuerEntries: [string, string][];
    validFrom: string; validTo: string; serialNumber: string; ca: boolean;
    subjectAltName?: string; infoAccess?: string; keyUsage?: string[];
    signatureAlgorithm: string; signatureAlgorithmOid: string;
    fingerprint: string; fingerprint256: string; fingerprint512: string;
  }
  interface CertificateBuffer extends Uint8Array { toString(encoding?: string): string }
  interface CertificateBufferFactory { from(value: Uint8Array | ArrayBuffer | string, encoding?: string): CertificateBuffer }
  interface CertificateKey {
    readonly type: "public" | "private" | "secret";
    readonly asymmetricKeyDetails?: { modulusLength?: number; namedCurve?: string };
    export(options: { type: "spki"; format: "der" }): CertificateBuffer;
    export(options: { format: "jwk" }): Record<string, string>;
  }
  interface CertificateKeys {
    KeyObject: { new(): CertificateKey };
    createPublicKey(input: CertificateKey | { key: Uint8Array; type: "spki"; format: "der" }): CertificateKey;
  }
  interface Native {
    x509(op: "parse", data: Uint8Array): CertificateData;
    x509(op: "publicKey", data: Uint8Array): Uint8Array;
    x509(op: "checkHost" | "checkEmail" | "checkIP", data: Uint8Array, name: string, flags: number): string | undefined;
    x509(op: "checkIssued" | "verify", data: Uint8Array, other: Uint8Array): boolean;
  }
}
