// The bulk computation of a validated SubtleCrypto call on the host engine's own Web Crypto.
// The runtime's provider (crypto.js) normalizes arguments, checks keys and usages and owns
// every message; this module only runs digests, AES encryption and signatures on the host
// when it supports the algorithm and key, because the host's native code is far faster than
// the guest's. An undefined result means the guest computes now. Calls the host gets wrong or
// refuses never reach it: a host key that failed to import, and AES-CTR whose counter wraps
// (WebKit computes those blocks wrongly). A host promise that rejects with `refused` asks the
// guest to compute from `input`; any other rejection is the operation's own failure.
//
// The host snapshots its input when it is called, so a call made synchronously passes the
// caller's bytes without a copy. Only the first use of a key, which waits for the host to
// import it, copies the input at call time; a refused import then computes from that copy.
(function (): BunWasm.HostComputeFactory {
  "use strict";
  type Plan = BunWasm.CryptoOperationPlan;
  type Material = BunWasm.CryptoHostImport;
  type Bytes = BunWasm.HostBytes;
  const digests = new Set(["SHA-1", "SHA-256", "SHA-384", "SHA-512"]);
  const ciphers = new Set(["AES-GCM", "AES-CBC", "AES-CTR"]);
  const signatures = new Set(["HMAC", "RSASSA-PKCS1-v1_5", "RSA-PSS", "ECDSA"]);
  const refused = new Error("host key refused");
  // Whether AES-CTR runs its `length`-bit counter field past its last value over `size` bytes.
  function counterWraps(counter: Bytes, length: number, size: number) {
    let value = 0n;
    for (const byte of counter) value = (value << 8n) | BigInt(byte);
    const space = 1n << BigInt(length);
    return (value % space) + BigInt(Math.ceil(size / 16)) > space;
  }
  return function hostCompute(host, helpers) {
    // The host key for each guest key: imported once, null when the host refuses it
    // (AES-192 on Chromium, for example).
    const ready = new WeakMap<CryptoKey, CryptoKey | null>();
    const importing = new WeakMap<CryptoKey, Promise<CryptoKey | null>>();
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
    function importKey(plan: Plan): Promise<CryptoKey | null> {
      let pending = importing.get(plan.key);
      if (pending) return pending;
      const m = material(plan.r);
      pending = (m ? importHost(m) : Promise.reject(new Error("no host key"))).then(key => key, () => null);
      pending.then(key => ready.set(plan.key, key));
      importing.set(plan.key, pending);
      return pending;
    }
    function offload<T>(plan: Plan, data: Bytes, call: (key: CryptoKey, input: Bytes) => Promise<T>): BunWasm.HostOffload<T> | undefined {
      const known = ready.get(plan.key);
      if (known === null) return undefined;
      if (known) return { promise: call(known, data), input: data };
      const input = helpers.buffer(data);
      const promise = importKey(plan).then(key => {
        if (!key) throw refused;
        return call(key, input);
      });
      return { promise, input };
    }
    function cipherParams(plan: Plan) {
      const a = plan.a, name = a.name;
      if (name === "AES-CTR") return { name, counter: helpers.buffer(a.counter), length: plan.out.length };
      if (name === "AES-CBC") return { name, iv: helpers.buffer(a.iv) };
      const params: { name: string; iv: Bytes; tagLength?: number; additionalData?: Bytes } =
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
      refused,
      digest(name, data) {
        return digests.has(name) ? { promise: host.digest(name, data), input: data } : undefined;
      },
      crypt(plan, data) {
        if (!ciphers.has(plan.a.name)) return undefined;
        if (plan.a.name === "AES-CTR" && counterWraps(helpers.buffer(plan.a.counter), plan.out.length ?? 0, data.length)) return undefined;
        const params = cipherParams(plan);
        const operation = plan.op === "decrypt" ? host.decrypt : host.encrypt;
        return offload(plan, data, (key, input) => operation(params, key, input));
      },
      sign(plan, data) {
        if (!signatures.has(plan.a.name)) return undefined;
        const params = signParams(plan);
        return offload(plan, data, (key, input) => host.sign(params, key, input));
      },
      verify(plan, signature, data) {
        if (!signatures.has(plan.a.name)) return undefined;
        const params = signParams(plan);
        return offload(plan, data, (key, input) => host.verify(params, key, signature, input));
      },
    };
  };
});
