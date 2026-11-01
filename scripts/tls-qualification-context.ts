export const qualificationCases = ["verified", "no-extra-ca", "hostname", "rejection", "plaintext"] as const;
export type QualificationCase = typeof qualificationCases[number];
export type QualificationEngine = "quickjs" | "jsc" | "browser";
export function isCase(value: unknown): value is QualificationCase { return qualificationCases.some(mode => mode === value); }
export function isEngine(value: unknown): value is QualificationEngine { return value === "quickjs" || value === "jsc" || value === "browser"; }
export function assertPgResult(value: unknown, mode: QualificationCase) {
  if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "tls-pg-result" || !("mode" in value) || value.mode !== mode) throw new Error("Invalid guest pg result");
  if (mode !== "verified") {
    if (!("rejected" in value) || value.rejected !== true) throw new Error("TLS control was not rejected");
    return { kind: "tls-pg-result", mode, rejected: true };
  }
  if (!("ssl" in value) || value.ssl !== true || !("sameBackend" in value) || value.sameBackend !== true
    || !("version" in value) || value.version !== "TLSv1.2" && value.version !== "TLSv1.3"
    || !("cipher" in value) || typeof value.cipher !== "string" || !value.cipher
    || !("bits" in value) || typeof value.bits !== "number" || !Number.isSafeInteger(value.bits) || value.bits < 128) throw new Error("pg_stat_ssl did not prove TLS on this backend");
  return { kind: "tls-pg-result", mode, ssl: true, sameBackend: true, version: value.version, cipher: value.cipher, bits: value.bits };
}
export function assertCaseContext(value: unknown, mode: QualificationCase, engine: QualificationEngine) {
  if (!value || typeof value !== "object" || !("engine" in value) || value.engine !== engine || !("carrier" in value)
    || value.carrier !== "websocket" || !("connections" in value) || value.connections !== 1
    || !("runtimeDisposed" in value) || value.runtimeDisposed !== true || !("relayClosed" in value) || value.relayClosed !== true
    || !("result" in value)) throw new Error("TLS engine/carrier/lifecycle context mismatch");
  return { engine, carrier: "websocket", connections: 1, runtimeDisposed: true, relayClosed: true, result: assertPgResult(value.result, mode) };
}
