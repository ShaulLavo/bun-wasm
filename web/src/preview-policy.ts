export type PreviewDocumentPolicy = {
  contentSecurityPolicy: string;
  bootstrapURL: string;
  hostResourcePaths: readonly string[];
};
export type PreviewPolicyState = { kind: "none" } | { kind: "configured"; policy: PreviewDocumentPolicy } | { kind: "invalid"; reason: string };
declare global { var __bunwasmPreviewPolicy: unknown; }
const parameter = "preview-policy";

function canonicalPath(value: unknown, origin: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || /[%\\\s<>"'?#]/.test(value)) throw new Error("Invalid host resource path");
  const url = new URL(value, origin);
  if (url.origin !== origin || url.pathname !== value || value.split("/").some(part => part === "." || part === "..")) throw new Error("Noncanonical host resource path");
  return value;
}
export function parsePreviewDocumentPolicy(value: unknown, origin: string): PreviewDocumentPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preview document policy");
  if (Object.keys(value).sort().join(",") !== "bootstrapURL,contentSecurityPolicy,hostResourcePaths") throw new Error("Unexpected preview policy fields");
  if (!("contentSecurityPolicy" in value) || typeof value.contentSecurityPolicy !== "string" || !value.contentSecurityPolicy.trim()) throw new Error("Missing preview CSP");
  new Headers({ "content-security-policy": value.contentSecurityPolicy });
  if (!("bootstrapURL" in value) || typeof value.bootstrapURL !== "string") throw new Error("Missing preview bootstrap URL");
  const script = new URL(value.bootstrapURL, origin);
  if (script.origin !== origin || script.username || script.password || script.search || script.hash) throw new Error("Preview bootstrap must be same-origin");
  const scriptPath = canonicalPath(script.pathname, origin);
  if (script.href !== value.bootstrapURL || script.href !== script.origin + scriptPath) throw new Error("Preview bootstrap URL must be canonical and absolute");
  if (!("hostResourcePaths" in value) || !Array.isArray(value.hostResourcePaths)) throw new Error("Missing host resource paths");
  const hostResourcePaths = value.hostResourcePaths.map(path => canonicalPath(path, origin));
  if (!hostResourcePaths.includes(scriptPath) || new Set(hostResourcePaths).size !== hostResourcePaths.length) throw new Error("Invalid bootstrap host resource declaration");
  return { contentSecurityPolicy: value.contentSecurityPolicy, bootstrapURL: script.href, hostResourcePaths };
}
export function previewWorkerURL(baseURL: string, requested?: unknown): string {
  const url = new URL("./sw.js", baseURL);
  if (requested === undefined) return url.href;
  try { url.searchParams.set(parameter, JSON.stringify(parsePreviewDocumentPolicy(requested, url.origin))); }
  catch { url.searchParams.set(parameter, "invalid"); }
  return url.href;
}
export function readPreviewWorkerPolicy(scriptURL: string): PreviewPolicyState {
  const url = new URL(scriptURL);
  const values = url.searchParams.getAll(parameter);
  if (!values.length) return { kind: "none" };
  if (values.length !== 1) return { kind: "invalid", reason: "Duplicate preview policy" };
  try { return { kind: "configured", policy: parsePreviewDocumentPolicy(JSON.parse(values[0] ?? ""), url.origin) }; }
  catch { return { kind: "invalid", reason: "Invalid requested preview policy" }; }
}
export function isPreviewHostResource(requestURL: string, state: PreviewPolicyState, origin: string): boolean {
  if (state.kind !== "configured") return false;
  const url = new URL(requestURL);
  return url.origin === origin && url.href === origin + url.pathname && state.policy.hostResourcePaths.includes(url.pathname);
}
