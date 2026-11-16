import { expect, test } from "bun:test";
import { previewNavigations } from "../src/preview-navigation";

const scope = "https://example.test/app/__preview/";
const url = scope + "5173/page?query=one";
function request(target: string, referrer = "", method = "GET"): Request {
  return Object.defineProperty(new Request(target, { method }), "referrer", { value: referrer });
}
function navigation(target = url, referrer = ""): Request {
  return Object.defineProperty(request(target, referrer), "mode", { value: "navigate" });
}
function fixture() {
  const requests: Request[] = [];
  const response = Promise.withResolvers<Response>();
  const responses = [response];
  const router = previewNavigations({ scope, fetch(request) {
    if (requests.length) responses.push(Promise.withResolvers<Response>());
    requests.push(request);
    return responses[requests.length - 1]!.promise;
  } });
  const begin = (target = url) => {
    const result = router.fetch(navigation(target), "owner");
    if (!(result instanceof Response)) throw new Error("Expected immediate loading redirect");
    const loading = result.headers.get("location");
    if (!loading) throw new Error("Missing loading URL");
    return loading;
  };
  return { router, response, responses, requests, begin };
}
async function status(router: ReturnType<typeof previewNavigations>, loading: string): Promise<Response> {
  const response = await router.fetch(request(loading + "/status", loading), "loading-client");
  if (!response) throw new Error("Missing loading status response");
  return response;
}

test("loading navigation hands back the original status, headers and stream without another guest request", async () => {
  const { router, requests, response, begin } = fixture();
  const loading = begin();
  expect(await (await status(router, loading)).json()).toEqual({ ready: false });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("guest body")); controller.close(); } });
  const original = new Response(body, { status: 451, statusText: "Unavailable For Legal Reasons", headers: { "x-guest": "preserved", "content-security-policy": "default-src 'none'", "content-type": "text/plain" } });
  response.resolve(original);
  await response.promise;
  expect(await (await status(router, loading)).json()).toEqual({ ready: true });
  const delivered = await router.fetch(navigation(url, loading), "loading-client");
  expect(delivered).toBe(original);
  expect(delivered?.status).toBe(451);
  expect(delivered?.headers.get("x-guest")).toBe("preserved");
  expect(delivered?.headers.get("content-security-policy")).toBe("default-src 'none'");
  expect(await delivered?.text()).toBe("guest body");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(url);
  expect((await status(router, loading)).status).toBe(410);
});

test("same-URL navigations have separate loading identities and reject foreign status requests", async () => {
  const { router, response, responses, begin } = fixture();
  const first = begin();
  const second = begin();
  expect(first).not.toBe(second);
  expect((await router.fetch(request(first + "/status", second), "other"))?.status).toBe(403);
  expect(await (await status(router, first)).json()).toEqual({ ready: false });
  response.resolve(new Response("done"));
  await response.promise;
  expect((await router.fetch(navigation(url, first), "first"))?.status).toBe(200);
  expect(await (await status(router, second)).json()).toEqual({ ready: false });
  responses[1]!.resolve(new Response("second response"));
  await responses[1]!.promise;
  expect(await (await status(router, second)).json()).toEqual({ ready: true });
  await router.fetch(request(second + "/cancel/0", second, "POST"), "second");
});

test("closing a loading page cancels a late body and releases its pending response", async () => {
  const { router, response, begin } = fixture();
  const loading = begin();
  let cancelled = false;
  expect((await router.fetch(request(loading + "/cancel/0", loading, "POST"), "loader"))?.status).toBe(204);
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await response.promise;
  expect(cancelled).toBe(true);
  expect((await status(router, loading)).status).toBe(410);
});

test("closing a loaded waiting response cancels the stream", async () => {
  const { router, response, begin } = fixture();
  const loading = begin();
  let cancelled = false;
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await response.promise;
  await router.fetch(request(loading + "/cancel/0", loading, "POST"), "loader");
  expect(cancelled).toBe(true);
});

test("a failed guest request remains a failure when the loading page returns to the application URL", async () => {
  const { router, response, begin } = fixture();
  const loading = begin();
  const failure = new TypeError("Original guest request failure");
  response.reject(failure);
  await response.promise.catch(() => {});
  expect(await (await status(router, loading)).json()).toEqual({ ready: true });
  await expect(router.fetch(navigation(url, loading), "loader")).rejects.toBe(failure);
  expect((await status(router, loading)).status).toBe(410);
});

test("subresources, other origins and non-GET navigations keep their existing routing", () => {
  const { router, requests } = fixture();
  expect(router.fetch(new Request(url), "owner")).toBeUndefined();
  expect(router.fetch(navigation("https://other.test/__preview/5173/"), "owner")).toBeUndefined();
  expect(router.fetch(navigation("https://example.test/app/other"), "owner")).toBeUndefined();
  const post = Object.defineProperty(new Request(url, { method: "POST", body: "keep the body" }), "mode", { value: "navigate" });
  expect(router.fetch(post, "owner")).toBeUndefined();
  expect(requests).toHaveLength(0);
});

test("a replaced loading document cannot cancel its replacement's request", async () => {
  const { router, response, begin } = fixture();
  const loading = begin();
  await router.fetch(navigation(loading), "first-document");
  await router.fetch(navigation(loading), "replacement-document");
  await router.fetch(request(loading + "/cancel/1", loading, "POST"), "first-document");
  expect(await (await status(router, loading)).json()).toEqual({ ready: false });
  response.resolve(new Response("Reloaded preview"));
  await response.promise;
  expect(await (await router.fetch(navigation(url, loading), "replacement-document"))?.text()).toBe("Reloaded preview");
});
