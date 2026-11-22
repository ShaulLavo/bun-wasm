// The bulk computation of a validated SubtleCrypto call on the host engine's own Web Crypto.
// The runtime's provider (crypto.js) normalizes arguments, checks keys and usages and owns
// every message; this module only runs digests, AES encryption and signatures on the host
// when it supports the algorithm and key, because the host's native code is far faster than
// the guest's. An undefined result, or a rejected promise, means the guest computes instead,
// so the guest also answers every failure with its own error.
(function (): BunWasm.HostComputeFactory {
  "use strict";
  type Plan = BunWasm.CryptoOperationPlan;
  type Material = BunWasm.CryptoHostImport;
  const digests = new Set(["SHA-1", "SHA-256", "SHA-384", "SHA-512"]);
  const ciphers = new Set(["AES-GCM", "AES-CBC", "AES-CTR"]);
  const signatures = new Set(["HMAC", "RSASSA-PKCS1-v1_5", "RSA-PSS", "ECDSA"]);
  return function hostCompute(host, helpers) {
    // One host key per guest key, imported on first use; null when the host refuses it
    // (AES-192 on Chromium, for example).
    const keys = new WeakMap<CryptoKey, Promise<CryptoKey | null>>();
    function jwk(material: JsonWebKey): JsonWebKey {
      const out = { ...material, ext: true };
      delete out.alg;
      delete out.key_ops;
      delete out.use;
      return out;
    }
    function hashName(r: Plan["r"]) {
      const hash = r.algorithm.hash;
      return typeof hash === "string" ? hash : hash?.name;
    }
    function material(r: Plan["r"]): Material | undefined {
      const name = r.algorithm.name;
      if (ciphers.has(name)) return { format: "raw", data: helpers.decode(r.key.k), algorithm: { name }, usages: ["encrypt", "decrypt"] };
      if (name === "HMAC") {
        const data = helpers.decode(r.key.k);
        if (r.algorithm.length !== undefined && r.algorithm.length !== data.length * 8) return undefined;
        return { format: "raw", data, algorithm: { name, hash: hashName(r) }, usages: ["sign", "verify"] };
      }
      const usages: KeyUsage[] = r.type === "private" ? ["sign"] : ["verify"];
      if (name === "ECDSA") return { format: "jwk", data: jwk(r.key), algorithm: { name, namedCurve: r.algorithm.namedCurve }, usages };
      return { format: "jwk", data: jwk(r.key), algorithm: { name, hash: hashName(r) }, usages };
    }
    function importHost(m: Material) {
      return m.format === "raw"
        ? host.importKey("raw", m.data, m.algorithm, false, m.usages)
        : host.importKey("jwk", m.data, m.algorithm, false, m.usages);
    }
    function hostKey(plan: Plan): Promise<CryptoKey> {
      let pending = keys.get(plan.key);
      if (!pending) {
        const m = material(plan.r);
        pending = m ? importHost(m).then(key => key, () => null) : Promise.resolve(null);
        keys.set(plan.key, pending);
      }
      return pending.then(key => {
        if (!key) throw new Error("host key unavailable");
        return key;
      });
    }
    function cipherParams(plan: Plan) {
      const a = plan.a, name = a.name;
      if (name === "AES-CTR") return { name, counter: helpers.buffer(a.counter), length: plan.out.length };
      if (name === "AES-CBC") return { name, iv: helpers.buffer(a.iv) };
      const params: { name: string; iv: Uint8Array<ArrayBuffer>; tagLength?: number; additionalData?: Uint8Array<ArrayBuffer> } =
        { name, iv: helpers.buffer(a.iv), tagLength: plan.out.tagLength };
      if (a.additionalData !== undefined) params.additionalData = helpers.buffer(a.additionalData);
      return params;
    }
    function signParams(plan: Plan) {
      const name = plan.a.name;
      if (name === "RSA-PSS") return { name, saltLength: plan.a.saltLength };
      if (name === "ECDSA") return { name, hash: plan.out.hash?.name };
      return { name };
    }
    return {
      digest(name, data) {
        return digests.has(name) ? host.digest(name, data) : undefined;
      },
      crypt(plan, data) {
        if (!ciphers.has(plan.a.name)) return undefined;
        const params = cipherParams(plan);
        const operation = plan.op === "decrypt" ? host.decrypt : host.encrypt;
        return hostKey(plan).then(key => operation(params, key, data));
      },
      sign(plan, data) {
        if (!signatures.has(plan.a.name)) return undefined;
        const params = signParams(plan);
        return hostKey(plan).then(key => host.sign(params, key, data));
      },
      verify(plan, signature, data) {
        if (!signatures.has(plan.a.name)) return undefined;
        const params = signParams(plan);
        return hostKey(plan).then(key => host.verify(params, key, signature, data));
      },
    };
  };
});
