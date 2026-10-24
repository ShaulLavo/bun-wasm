(function (internal: BunWasm.Internal) {
  "use strict";
  const c = internal.crypto;
  const provider = internal.native.subtleCrypto;
  if (!provider) return;
  const operations = ["generateKey", "importKey", "exportKey", "sign", "verify", "encrypt", "decrypt", "deriveBits", "deriveKey", "wrapKey", "unwrapKey"] as const;
  const original = {
    generateKey: provider.generateKey, importKey: provider.importKey, exportKey: provider.exportKey,
    sign: provider.sign, verify: provider.verify, encrypt: provider.encrypt, decrypt: provider.decrypt,
    deriveBits: provider.deriveBits, deriveKey: provider.deriveKey, wrapKey: provider.wrapKey, unwrapKey: provider.unwrapKey,
  };
  const host = {
    generateKey: original.generateKey.bind(provider), importKey: original.importKey.bind(provider), exportKey: original.exportKey.bind(provider),
    sign: original.sign.bind(provider), verify: original.verify.bind(provider), encrypt: original.encrypt.bind(provider), decrypt: original.decrypt.bind(provider),
    deriveBits: original.deriveBits.bind(provider), deriveKey: original.deriveKey.bind(provider), wrapKey: original.wrapKey.bind(provider), unwrapKey: original.unwrapKey.bind(provider),
  };
  const converted = new WeakMap<CryptoKey, Promise<CryptoKey>>();
  const nameOf: (a: BunWasm.CryptoAlgorithm) => string = a => typeof a === "string" ? a.toUpperCase() : a.name.toUpperCase();
  const derivation: (a: BunWasm.CryptoAlgorithm) => boolean = a => ["HKDF", "PBKDF2"].includes(nameOf(a));
  type ClonedData = { kind: "bytes"; data: Uint8Array<ArrayBuffer> } | { kind: "jwk"; data: BunWasm.CryptoImportData };
  function cloneData(format: unknown, data: BunWasm.CryptoImportData): ClonedData {
    if (format !== "jwk") return {kind:"bytes", data:c.buffer(data)};
    const material: BunWasm.CryptoImportData = {};
    for (const field of ["kty", "crv", "k", "n", "e", "d", "p", "q", "dp", "dq", "qi", "x", "y"] as const) {
      const value = data[field];
      if (value !== undefined) material[field] = value;
    }
    return {kind:"jwk", data:material};
  }
  function remember(key: CryptoKey, jwk: BunWasm.CryptoImportData) {
    c.rememberKey(key, jwk);
    return key;
  }
  async function retain(key: CryptoKey, extractable: boolean) {
    const jwk = await host.exportKey("jwk", key);
    if (key.type !== "public" && !extractable)
      key = await host.importKey("jwk", jwk, key.algorithm, false, key.usages);
    return remember(key, jwk);
  }
  async function importHost(format: unknown, data: BunWasm.CryptoImportData, a: BunWasm.CryptoAlgorithm, extractable: boolean, usages: Iterable<KeyUsage>) {
    const saved = cloneData(format, data);
    const key = await host.importKey(format, data, a, extractable, usages);
    if (format === "raw" && key.type === "secret")
      return remember(key, {kty:"oct", k:c.encode(saved.data)});
    if (saved.kind === "jwk") return remember(key, saved.data);
    if (key.extractable) return retain(key, true);
    const copy = await host.importKey(format, saved.data, a, true, usages);
    return remember(key, await host.exportKey("jwk", copy));
  }
  async function toHost(key: CryptoKey): Promise<CryptoKey> {
    if (!c.isWasmKey(key)) return key;
    const cached = converted.get(key);
    if (cached) return cached;
    const r = c.record(key);
    const pending = derivation(r.algorithm)
      ? host.importKey("raw", c.decode(r.key.k), r.algorithm, r.extractable, r.usages)
      : host.importKey("jwk", {...r.key, ext:r.extractable, key_ops:r.usages}, r.algorithm, r.extractable, r.usages);
    converted.set(key, pending);
    return pending;
  }
  async function agreement(a: BunWasm.CryptoAlgorithm) {
    return a && typeof a === "object" && a.public
      ? {...a, public:await toHost(a.public)} : a;
  }
  provider.importKey = importHost;
  provider.generateKey = async (a, extractable, usages) => {
    const result = await host.generateKey(a, true, usages);
    if (!result.privateKey) return retain(result, extractable);
    const [privateKey, publicKey] = await Promise.all([
      retain(result.privateKey, extractable), retain(result.publicKey, true),
    ]);
    return {privateKey, publicKey};
  };
  provider.exportKey = async (format, key) => {
    if (!c.isWasmKey(key)) return host.exportKey(format, key);
    format = String(format);
    return host.exportKey(format, await toHost(key));
  };
  async function keyOperation<Result>(operation: (a: BunWasm.CryptoAlgorithm, key: CryptoKey, ...input: (BufferSource | undefined)[]) => Promise<Result>, a: BunWasm.CryptoAlgorithm, key: CryptoKey, ...input: (BufferSource | undefined)[]) {
    if (!c.isWasmKey(key)) return operation(a, key, ...input);
    const bytes = input.map(data => c.buffer(data));
    const op = snapshot(a);
    return toHost(key).then(converted => operation(op, converted, ...bytes));
  }
  function snapshot(a: BunWasm.CryptoAlgorithm) {
    if (!a || typeof a !== "object") return a;
    const out = {...a};
    for (const field of ["iv", "counter", "additionalData", "label", "salt", "info"] as const)
      if (out[field] !== undefined) out[field] = c.buffer(out[field]);
    if (a.hash && typeof a.hash === "object") out.hash = {...a.hash};
    return out;
  }
  provider.sign = async (a, key, ...input) => keyOperation((op, converted, ...bytes) => host.sign(op, converted, ...bytes), a, key, ...input);
  provider.verify = async (a, key, ...input) => keyOperation((op, converted, ...bytes) => host.verify(op, converted, ...bytes), a, key, ...input);
  provider.encrypt = async (a, key, ...input) => keyOperation((op, converted, ...bytes) => host.encrypt(op, converted, ...bytes), a, key, ...input);
  provider.decrypt = async (a, key, ...input) => keyOperation((op, converted, ...bytes) => host.decrypt(op, converted, ...bytes), a, key, ...input);
  provider.deriveBits = async (a, key, length) => {
    if (!c.isWasmKey(key) && !c.isWasmKey(a?.public)) return host.deriveBits(a, key, length);
    const op = snapshot(a);
    return Promise.all([agreement(op), toHost(key)]).then(([params, converted]) => host.deriveBits(params, converted, length));
  };
  provider.deriveKey = async (a, key, derived, extractable, usages) => {
    if (!c.isWasmKey(key) && !c.isWasmKey(a?.public))
      return retain(await host.deriveKey(a, key, derived, true, usages), extractable);
    const params = snapshot(a), target = snapshot(derived), policy = Array.from(usages);
    return retain(await host.deriveKey(await agreement(params), await toHost(key), target, true, policy), extractable);
  };
  provider.wrapKey = async (format, key, wrappingKey, a) => {
    if (!c.isWasmKey(key) && !c.isWasmKey(wrappingKey)) return host.wrapKey(format, key, wrappingKey, a);
    const params = snapshot(a);
    format = String(format);
    return host.wrapKey(format, await toHost(key), await toHost(wrappingKey), params);
  };
  provider.unwrapKey = async (format, wrapped, key, a, unwrapped, extractable, usages) => {
    const params = snapshot(a), target = snapshot(unwrapped), bytes = c.buffer(wrapped), policy = Array.from(usages);
    if (!derivation(target))
      return retain(await host.unwrapKey(format, bytes, await toHost(key), params, target, true, policy), extractable);
    const result = await host.unwrapKey(format, bytes, await toHost(key), params, target, extractable, policy);
    if (!c.isKey(key) || !c.supportsAlgorithm(nameOf(params))) return result;
    const raw = c.crypt("decrypt", params, key, bytes, "unwrapKey");
    return remember(result, {kty:"oct", k:c.encode(raw)});
  };  for (const name of operations) {
    const bridge = provider[name], operation = original[name];
    const wrapper = { [name](this: unknown, ...args: unknown[]): unknown {
      return Reflect.apply(this === provider ? bridge : operation, this, args);
    } }[name];
    Object.defineProperty(wrapper, "length", {value:operation.length});
    Object.defineProperty(provider, name, {value:wrapper, writable:true, configurable:true});
  }
});
