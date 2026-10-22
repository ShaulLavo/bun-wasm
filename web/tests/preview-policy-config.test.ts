import { expect, test } from "bun:test";
import { isPreviewHostResource, parsePreviewDocumentPolicy, previewWorkerURL, readPreviewWorkerPolicy } from "../src/preview-policy";
import { previewPolicyResponse } from "../src/preview-policy-response";
import { prependPreviewScript } from "../src/preview-policy-stream";

const origin = "https://example.test";
const policy = { contentSecurityPolicy: "connect-src 'self'", bootstrapURL: origin + "/app/policy.js", hostResourcePaths: ["/app/policy.js", "/app/fixed-json"] };
const state = readPreviewWorkerPolicy(previewWorkerURL(origin + "/app/", policy));

test("policy persists in the existing registration URL and absent policy stays absent", () => {
  expect(previewWorkerURL(origin + "/app/")).toBe(origin + "/app/sw.js");
  expect(readPreviewWorkerPolicy(origin + "/app/sw.js")).toEqual({ kind: "none" });
  expect(state).toEqual({ kind: "configured", policy });
  expect(readPreviewWorkerPolicy(previewWorkerURL(origin + "/app/", null)).kind).toBe("invalid");
  expect(readPreviewWorkerPolicy(origin + "/sw.js?preview-policy=&preview-policy=").kind).toBe("invalid");
  for (const path of ["/app/policy.js", "/app/fixed-json"]) expect(isPreviewHostResource(origin + path, state, origin)).toBe(true);
  for (const path of ["/app/fixed-json/", "/app/other", "/app/%66ixed-json", "/app/fixed-json?x=1", "/app/fixed-json?", "/app/fixed-json#"]) expect(isPreviewHostResource(origin + path, state, origin)).toBe(false);
  expect(isPreviewHostResource("https://other.test/app/policy.js", state, origin)).toBe(false);
});

test("invalid requested descriptors never silently select unconfigured behavior", () => {
  const bad: unknown[] = [null, {}, { ...policy, extra: 1 }, { ...policy, contentSecurityPolicy: "" }, { ...policy, contentSecurityPolicy: "x\r\ny" }, { ...policy, bootstrapURL: "https://other.test/app/policy.js" }, { ...policy, bootstrapURL: origin + "/app/policy.js?x" }, { ...policy, hostResourcePaths: ["/app/policy.js", "/app/../bad"] }, { ...policy, hostResourcePaths: ["/app/policy.js", "/app/%2e/bad"] }, { ...policy, hostResourcePaths: ["/app/policy.js", "//other.test/x"] }, { ...policy, hostResourcePaths: [] }];
  for (const value of bad) {
    expect(() => parsePreviewDocumentPolicy(value, origin)).toThrow();
    expect(readPreviewWorkerPolicy(previewWorkerURL(origin, value)).kind).toBe("invalid");
  }
});

test("HTML decoration preserves doctype, chunk boundaries, status and unrelated headers", async () => {
  const encoder = new TextEncoder();
  const original = "  <!doctype html><html><script>guest()</script></html>";
  const chunks = ["  <!doc", "type html>", "<html><script>guest()</script></html>"];
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
  const upstream = new Response(body, { status: 418, statusText: "Teapot", headers: { "content-type": "text/html", "x-guest": "preserved", "content-length": String(original.length), etag: "stale", "content-security-policy": "img-src 'self'" } });
  const result = await previewPolicyResponse(upstream, new Request(origin), state);
  expect(result.status).toBe(418);
  expect(result.statusText).toBe("Teapot");
  expect(result.headers.get("x-guest")).toBe("preserved");
  expect(result.headers.get("content-length")).toBeNull();
  expect(result.headers.get("etag")).toBeNull();
  expect(result.headers.get("content-security-policy")).toContain("img-src 'self'");
  expect(result.headers.get("content-security-policy")).toContain("connect-src 'self'");
  expect(await result.text()).toBe(original.replace("<!doctype html>", `<!doctype html><script src="${policy.bootstrapURL}"></script>`));
});

test("encoded and unsupported HTML fail closed and cancel upstream", async () => {
  let cancelled = 0;
  const cases: Record<string, string>[] = [{ "content-type": "text/html", "content-encoding": "gzip" }, { "content-type": "application/xhtml+xml" }];
  for (const headers of cases) {
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    const response = await previewPolicyResponse(new Response(body, { headers }), new Request(origin), state);
    expect(response.status).toBe(502);
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(await response.text()).toContain("unsupported");
  }
  expect(cancelled).toBe(2);
});

test("stream cancellation reaches the original body and unconfigured responses retain identity", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("<!doctype html>")); }, cancel() { cancelled = true; } });
  const reader = prependPreviewScript(body, policy.bootstrapURL).getReader();
  await reader.read();
  await reader.cancel("navigation stopped");
  expect(cancelled).toBe(true);
  const original = new Response("ordinary body");
  expect(await previewPolicyResponse(original, new Request(origin), { kind: "none" })).toBe(original);
});

test("UTF-8 BOM and split multibyte tails preserve bytes around parser-first injection", async () => {
  const bytes = new TextEncoder().encode("\ufeff<!doctype html><p>é</p>");
  const split = bytes.indexOf(195) + 1;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } });
  const result = await new Response(prependPreviewScript(body, policy.bootstrapURL)).text();
  expect(result).toBe(`<!doctype html><script src="${policy.bootstrapURL}"></script><p>é</p>`);
});

test("upstream stream errors never emit unguarded bytes", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("fixture stream failed")); } });
  await expect(new Response(prependPreviewScript(body, policy.bootstrapURL)).text()).rejects.toThrow("fixture stream failed");
});

test("bootstrap descriptors reject empty and nonempty query and fragment suffixes", () => {
  for (const suffix of ["?", "#", "?x=1", "#fragment"]) {
    const requested = { ...policy, bootstrapURL: policy.bootstrapURL + suffix };
    expect(() => parsePreviewDocumentPolicy(requested, origin)).toThrow();
    expect(readPreviewWorkerPolicy(previewWorkerURL(origin, requested)).kind).toBe("invalid");
  }
});

test("configured redirects refuse resolved off-origin locations and audit before delivery", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let cancelled = false;
    const audits: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const upstream = new Response(body, { status, headers: { location: "//example.invalid/review-redirect", "content-type": "text/html" } });
    const request = new Request(origin + "/app/__preview/43100/redirect");
    const result = await previewPolicyResponse(upstream, request, state, entry => { audits.push(entry); });
    expect(result.status).toBe(502);
    expect(result.headers.has("location")).toBe(false);
    expect(await result.text()).toContain("Off-origin redirect");
    expect(cancelled).toBe(true);
    expect(audits).toEqual([{ requestURL: request.url, redirectURL: "https://example.invalid/review-redirect", method: "GET", reason: "Off-origin redirect is forbidden by preview policy" }]);
  }
});

test("same-origin relative redirects preserve status, Location, body and guest headers", async () => {
  for (const location of ["../permitted", "/app/__preview/43100/permitted", origin + "/app/__preview/43100/permitted"]) {
    const upstream = new Response("redirect body", { status: 302, statusText: "Found", headers: { location, "x-guest": "preserved" } });
    const result = await previewPolicyResponse(upstream, new Request(origin + "/app/__preview/43100/sub/redirect"), state);
    expect(result.status).toBe(302);
    expect(result.statusText).toBe("Found");
    expect(result.headers.get("location")).toBe(location);
    expect(result.headers.get("x-guest")).toBe("preserved");
    expect(await result.text()).toBe("redirect body");
  }
  const upstream = new Response(null, { status: 302, headers: { location: "https://example.invalid/unconfigured" } });
  expect(await previewPolicyResponse(upstream, new Request(origin), { kind: "none" })).toBe(upstream);
});

test("same-origin redirects without a document content type retain response identity", async () => {
  const response = new Response(null, { status: 302, headers: { location: "./permitted", "x-guest": "preserved" } });
  const request = new Request(origin + "/app/__preview/43100/redirect");
  Object.defineProperty(request, "destination", { value: "document" });
  expect(await previewPolicyResponse(response, request, state)).toBe(response);
});
