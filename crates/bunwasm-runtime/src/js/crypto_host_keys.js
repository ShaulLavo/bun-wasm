(function (internal) {
  "use strict";
  const c = internal.crypto;
  const provider = internal.native.subtleCrypto;
  if (!provider) return;
  const operations = ["generateKey", "importKey", "exportKey", "sign", "verify", "encrypt", "decrypt", "deriveBits", "deriveKey", "wrapKey", "unwrapKey"];
  const host = Object.fromEntries(operations.map(name => [name, provider[name].bind(provider)]));
  const converted = new WeakMap();
  const nameOf = a => typeof a === "string" ? a.toUpperCase() : a.name.toUpperCase();
  const derivation = a => ["HKDF", "PBKDF2"].includes(nameOf(a));
  const cloneData = (format, data) => format === "jwk" ? {...data} : c.buffer(data);
  function remember(key, jwk) {
    c.rememberKey(key, jwk);
    return key;
  }
  async function retain(key, extractable) {
    const jwk = await host.exportKey("jwk", key);
    if (key.type !== "public" && !extractable)
      key = await host.importKey("jwk", jwk, key.algorithm, false, key.usages);
    return remember(key, jwk);
  }
  async function importHost(format, data, a, extractable, usages) {
    const saved = cloneData(format, data);
    const key = await host.importKey(format, data, a, extractable, usages);
    if (format === "raw" && key.type === "secret")
      return remember(key, {kty:"oct", k:c.encode(saved)});
    if (format === "jwk") return remember(key, saved);
    if (key.extractable) return retain(key, true);
    const copy = await host.importKey(format, saved, a, true, usages);
    return remember(key, await host.exportKey("jwk", copy));
  }
  async function toHost(key) {
    if (!c.isWasmKey(key)) return key;
    if (converted.has(key)) return converted.get(key);
    const r = c.record(key);
    const pending = derivation(r.algorithm)
      ? host.importKey("raw", c.decode(r.key.k), r.algorithm, r.extractable, r.usages)
      : host.importKey("jwk", {...r.key, ext:r.extractable, key_ops:r.usages}, r.algorithm, r.extractable, r.usages);
    converted.set(key, pending);
    return pending;
  }
  async function agreement(a) {
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
  async function keyOperation(name, a, key, ...input) {
    if (!c.isWasmKey(key)) return host[name](a, key, ...input);
    const bytes = input.map(data => c.buffer(data));
    const op = snapshot(a);
    return toHost(key).then(converted => host[name](op, converted, ...bytes));
  }
  function snapshot(a) {
    if (!a || typeof a !== "object") return a;
    const out = {...a};
    for (const field of ["iv", "counter", "additionalData", "label", "salt", "info"])
      if (out[field] !== undefined) out[field] = c.buffer(out[field]);
    if (a.hash && typeof a.hash === "object") out.hash = {...a.hash};
    return out;
  }
  for (const name of ["sign", "verify", "encrypt", "decrypt"])
    provider[name] = async (a, key, ...input) => keyOperation(name, a, key, ...input);
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
  };
});
