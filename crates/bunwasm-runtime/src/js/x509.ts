(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  return function (Buffer: BunWasm.CertificateBufferFactory, keys: BunWasm.CertificateKeys) {
    function typeError(name: string) { return Object.assign(new TypeError(`The "${name}" argument has an invalid type`), { code: "ERR_INVALID_ARG_TYPE" }); }
    function valueError(name: string) { return Object.assign(new TypeError(`The "${name}" argument has an invalid value`), { code: "ERR_INVALID_ARG_VALUE" }); }
    function bytes(input: unknown): Uint8Array {
      if (typeof input === "string") return new TextEncoder().encode(input);
      if (input instanceof ArrayBuffer) return new Uint8Array(input);
      if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      throw typeError("buffer");
    }
    function flags(value: unknown): number {
      if (value === undefined) return 0;
      if (typeof value !== "object" || value === null) throw typeError("options");
      let result = 0;
      const subject: unknown = Reflect.get(value, "subject");
      if (subject !== undefined && typeof subject !== "string") throw typeError("options.subject");
      if (subject !== undefined && subject !== "default" && subject !== "always" && subject !== "never") throw valueError("options.subject");
      if (subject === "always") result |= 0x01;
      if (subject === "never") result |= 0x20;
      const options: [string, boolean, number][] = [["wildcards", false, 0x02], ["partialWildcards", false, 0x04], ["multiLabelWildcards", true, 0x08], ["singleLabelSubdomains", true, 0x10]];
      for (const [name, enabled, bit] of options) {
        const flag: unknown = Reflect.get(value, name);
        if (flag !== undefined && typeof flag !== "boolean") throw typeError(`options.${name}`);
        if (flag === enabled) result |= bit;
      }
      return result;
    }
    function nameEntries(entries: [string, string][]) {
      const result: Record<string, string | string[]> = Object.create(null);
      for (const [name, value] of entries) {
        const previous = result[name];
        result[name] = previous === undefined ? value : typeof previous === "string" ? [previous, value] : previous.concat([value]);
      }
      return result;
    }
    function pem(raw: Uint8Array) {
      const base64 = Buffer.from(raw).toString("base64");
      const lines = base64.match(/.{1,64}/g) ?? [];
      return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
    }
    function keyBytes(key: unknown, expected: "public" | "private"): Uint8Array {
      if (!(key instanceof keys.KeyObject)) throw typeError("key");
      if (key.type !== expected) throw valueError("key");
      return (expected === "public" ? key : keys.createPublicKey(key)).export({ type: "spki", format: "der" });
    }

    class X509Certificate {
      #data: BunWasm.CertificateData;
      #publicKey: BunWasm.CertificateKey | undefined;
      constructor(input: unknown) { this.#data = native.x509("parse", bytes(input)); }
      get subject() { return this.#data.subject; }
      get issuer() { return this.#data.issuer; }
      get subjectAltName() { return this.#data.subjectAltName; }
      get infoAccess() { return this.#data.infoAccess; }
      get validFrom() { return this.#data.validFrom; }
      get validTo() { return this.#data.validTo; }
      get validFromDate() { return new Date(this.validFrom); }
      get validToDate() { return new Date(this.validTo); }
      get fingerprint() { return this.#data.fingerprint; }
      get fingerprint256() { return this.#data.fingerprint256; }
      get fingerprint512() { return this.#data.fingerprint512; }
      get serialNumber() { return this.#data.serialNumber; }
      get ca() { return this.#data.ca; }
      get keyUsage() { return this.#data.keyUsage?.slice(); }
      get raw() { return Buffer.from(this.#data.raw); }
      get signatureAlgorithm() { return this.#data.signatureAlgorithm; }
      get signatureAlgorithmOid() { return this.#data.signatureAlgorithmOid; }
      get publicKey() {
        this.#publicKey ??= keys.createPublicKey({ key: native.x509("publicKey", this.#data.raw), type: "spki", format: "der" });
        return this.#publicKey;
      }
      get issuerCertificate(): X509Certificate | undefined { return undefined; }
      checkHost(name: unknown, options?: unknown) {
        if (typeof name !== "string") throw typeError("name");
        return native.x509("checkHost", this.#data.raw, name, flags(options));
      }
      checkEmail(email: unknown, options?: unknown) {
        if (typeof email !== "string") throw typeError("email");
        return native.x509("checkEmail", this.#data.raw, email, flags(options));
      }
      checkIP(ip: unknown, options?: unknown) {
        if (typeof ip !== "string") throw typeError("ip");
        return native.x509("checkIP", this.#data.raw, ip, flags(options));
      }
      checkIssued(other: unknown) {
        if (!(other instanceof X509Certificate)) throw typeError("otherCert");
        return native.x509("checkIssued", this.#data.raw, other.#data.raw);
      }
      verify(key: unknown) { return native.x509("verify", this.#data.raw, keyBytes(key, "public")); }
      checkPrivateKey(key: unknown) {
        const publicKey = keyBytes(key, "private");
        const ownKey = native.x509("publicKey", this.#data.raw);
        return ownKey.length === publicKey.length && ownKey.every((byte, index) => byte === publicKey[index]);
      }
      toString() { return pem(this.#data.raw); }
      toJSON() { return this.toString(); }
      toLegacyObject() {
        const result: Record<string, unknown> = {
          subject: nameEntries(this.#data.subjectEntries),
          issuer: nameEntries(this.#data.issuerEntries),
          subjectaltname: this.subjectAltName,
          ca: this.ca,
          valid_from: this.validFrom,
          valid_to: this.validTo,
          fingerprint: this.fingerprint,
          fingerprint256: this.fingerprint256,
          fingerprint512: this.fingerprint512,
          serialNumber: this.serialNumber,
          raw: this.raw,
        };
        if (this.keyUsage) result.ext_key_usage = this.keyUsage;
        if (this.infoAccess) result.infoAccess = legacyInfoAccess(this.infoAccess);
        this.#legacyPublicKey(result);
        return result;
      }
      #legacyPublicKey(result: Record<string, unknown>) {
        let key: BunWasm.CertificateKey;
        try { key = this.publicKey; } catch { return; }
        result.pubkey = key.export({ type: "spki", format: "der" });
        const jwk = key.export({ format: "jwk" });
        if (jwk.kty === "RSA") {
          result.modulus = Buffer.from(jwk.n, "base64url").toString("hex").toUpperCase();
          result.bits = key.asymmetricKeyDetails?.modulusLength;
          const exponent = Array.from(Buffer.from(jwk.e, "base64url")).reduce((n, byte) => n * 256n + BigInt(byte), 0n);
          result.exponent = `0x${exponent.toString(16)}`;
        }
        if (jwk.kty === "EC") {
          result.bits = jwk.crv === "P-384" ? 384 : 256;
          result.asn1Curve = key.asymmetricKeyDetails?.namedCurve;
          result.nistCurve = jwk.crv;
          const x = Buffer.from(jwk.x, "base64url"), y = Buffer.from(jwk.y, "base64url");
          const point = new Uint8Array(1 + x.length + y.length);
          point[0] = 4;
          point.set(x, 1);
          point.set(y, x.length + 1);
          result.pubkey = Buffer.from(point);
        }
      }
    }
    function legacyInfoAccess(text: string) {
      const result: Record<string, string[]> = Object.create(null);
      for (const line of text.split("\n")) {
        const split = line.indexOf(":");
        if (split < 0) continue;
        const key = line.slice(0, split);
        (result[key] ??= []).push(line.slice(split + 1));
      }
      return result;
    }
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(X509Certificate.prototype))) {
      if (descriptor.get) Object.defineProperty(X509Certificate.prototype, name, { ...descriptor, enumerable: true });
    }
    Object.defineProperty(X509Certificate.prototype, Symbol.toStringTag, { value: "X509Certificate", configurable: true });
    return { X509Certificate };
  };
})
