import type { PreviewPolicyState } from "./preview-policy";
import { prependPreviewScript } from "./preview-policy-stream";

export function closedPreviewPolicy(reason: string, upstream?: Response): Response {
  void upstream?.body?.cancel(reason).catch(() => undefined);
  return new Response(`Preview policy refused response: ${reason}\n`, { status: 502, headers: {
    "content-type": "text/plain; charset=utf-8", "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp",
  } });
}
export async function previewPolicyResponse(response: Response | Promise<Response>, request: Request, state: PreviewPolicyState): Promise<Response> {
  const upstream = await response;
  if (state.kind === "none") return upstream;
  if (state.kind === "invalid") return closedPreviewPolicy(state.reason, upstream);
  const type = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const html = type === "text/html";
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(upstream.headers.get("content-type") ?? "")?.[1]?.toLowerCase();
  if (html && charset && charset !== "utf-8" && charset !== "utf8") return closedPreviewPolicy("Non-UTF-8 HTML is unsupported", upstream);
  const navigation = request.destination === "document" || request.destination === "iframe";
  if (navigation && !html && type !== "text/plain" && type !== "application/json") return closedPreviewPolicy("Unsupported active document type", upstream);
  if ((html || type === "application/xhtml+xml") && upstream.headers.has("content-encoding")) return closedPreviewPolicy("Encoded HTML is unsupported", upstream);
  if (type === "application/xhtml+xml") return closedPreviewPolicy("XHTML policy injection is unsupported", upstream);
  const headers = new Headers(upstream.headers);
  headers.append("content-security-policy", state.policy.contentSecurityPolicy);
  headers.set("x-content-type-options", "nosniff");
  if (!html || !upstream.body) return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  headers.delete("content-length");
  headers.delete("etag");
  const body = prependPreviewScript(upstream.body, state.policy.bootstrapURL);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}
