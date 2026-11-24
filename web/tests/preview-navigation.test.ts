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
function fixture(extra: { transientRetryMs?: number; retryDelaysMs?: readonly number[] } = {}) {
  const requests: Request[] = [];
  const response = Promise.withResolvers<Response>();
  const responses = [response];
  const clients = new Map<string, { url: string }>();
  const router = previewNavigations({ scope, clients: { async get(id) { return clients.get(id); } }, ...extra, fetch(request) {
    if (requests.length) responses.push(Promise.withResolvers<Response>());
    requests.push(request);
    return responses[requests.length - 1]!.promise;
  } });
  const begin = (target = url) => {
    const result = router.fetch(navigation(target), "owner");
    if (!(result instanceof Response)) throw new Error("Expected immediate loading redirect");
    const loading = result.headers.get("location");
    if (!loading) throw new Error("Missing loading URL");
    clients.set(loading, { url: loading });
    router.fetch(navigation(loading), "", loading);
    router.fetch(request(loading + "/status", loading), loading);
    return loading;
  };
  return { router, response, responses, requests, clients, begin };
}
async function status(router: ReturnType<typeof previewNavigations>, loading: string): Promise<Response> {
  const response = await router.fetch(request(loading + "/status", loading), loading);
  if (!response) throw new Error("Missing loading status response");
  return response;
}
async function until(accept: () => boolean | Promise<boolean>): Promise<void> {
  while (!await accept()) await Bun.sleep(0);
}
async function ready(router: ReturnType<typeof previewNavigations>, loading: string): Promise<void> {
  await until(async () => (await (await status(router, loading)).json()).ready === true);
}

test("loading navigation hands back the original status, headers and stream without another guest request", async () => {
  const { router, requests, response, begin } = fixture();
  const loading = begin();
  expect(await (await status(router, loading)).json()).toEqual({ ready: false });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("guest body")); controller.close(); } });
  const original = new Response(body, { status: 451, statusText: "Unavailable For Legal Reasons", headers: { "x-guest": "preserved", "content-security-policy": "default-src 'none'", "content-type": "text/plain" } });
  response.resolve(original);
  await ready(router, loading);
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
  await ready(router, second);
  expect(await (await status(router, second)).json()).toEqual({ ready: true });
  await router.fetch(request(second + "/cancel/1", second, "POST"), second);
});

test("closing a loading page cancels a late body and releases its pending response", async () => {
  const { router, response, begin } = fixture();
  const loading = begin();
  let cancelled = false;
  expect((await router.fetch(request(loading + "/cancel/1", loading, "POST"), loading))?.status).toBe(204);
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await until(() => cancelled);
  expect(cancelled).toBe(true);
  expect((await status(router, loading)).status).toBe(410);
});

test("closing a loaded waiting response cancels the stream", async () => {
  const { router, response, begin } = fixture();
  const loading = begin();
  let cancelled = false;
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await ready(router, loading);
  await router.fetch(request(loading + "/cancel/1", loading, "POST"), loading);
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
  await router.fetch(navigation(loading), "", loading);
  await router.fetch(request(loading + "/cancel/1", loading, "POST"), loading);
  expect(await (await status(router, loading)).json()).toEqual({ ready: false });
  response.resolve(new Response("Reloaded preview"));
  await response.promise;
  expect(await (await router.fetch(navigation(url, loading), "replacement-document"))?.text()).toBe("Reloaded preview");
});

test("only the bound loading client can poll or cancel, and a closed client cannot deliver a saved body", async () => {
  const { router, response, clients, begin } = fixture();
  const loading = begin();
  expect((await router.fetch(request(loading + "/status", loading), "foreign-client"))?.status).toBe(403);
  expect((await router.fetch(request(loading + "/cancel/1", loading, "POST"), "foreign-client"))?.status).toBe(403);
  response.resolve(new Response("owned body"));
  await response.promise;
  clients.delete(loading);
  expect((await router.fetch(navigation(url, loading), "", "new-document"))?.status).toBe(403);
  expect((await status(router, loading)).status).toBe(410);
});

test("simultaneous consumers cannot both own the saved response body", async () => {
  const { router, response, begin } = fixture();
  const loading = begin();
  response.resolve(new Response("one owner"));
  await ready(router, loading);
  const results = await Promise.all([
    router.fetch(navigation(url, loading), "", "first-result"),
    router.fetch(navigation(url, loading), "", "second-result"),
  ]);
  expect(results.map(result => result?.status).sort()).toEqual([200, 403]);
  expect(await results.find(result => result?.status === 200)?.text()).toBe("one owner");
});

function transient502(onCancel?: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("No bun.wasm server is listening on port 5173.\n")); },
    cancel() { onCancel?.(); },
  });
  return new Response(body, { status: 502, headers: { "content-type": "text/plain; charset=utf-8", "x-bun-preview-transient": "1" } });
}

test("transient preview-SW 502 retries across a probe-to-listen gap and cancels discarded bodies", async () => {
  const { router, requests, responses, begin } = fixture({ transientRetryMs: 500, retryDelaysMs: [5, 5] });
  const loading = begin();
  let cancelled = 0;
  responses[0]!.resolve(transient502(() => { cancelled++; }));
  await until(() => requests.length === 2);
  expect(await (await status(router, loading)).json()).toEqual({ ready: false });
  responses[1]!.resolve(transient502(() => { cancelled++; }));
  await until(() => requests.length === 3);
  responses[2]!.resolve(new Response("<h1>Live Vite</h1>", { status: 200, headers: { "content-type": "text/html" } }));
  await ready(router, loading);
  expect(cancelled).toBe(2);
  const delivered = await router.fetch(navigation(url, loading), "loading-client");
  expect(delivered?.status).toBe(200);
  expect(await delivered?.text()).toBe("<h1>Live Vite</h1>");
});

test("non-transient 502 is delivered immediately without retry", async () => {
  const { router, requests, response, begin } = fixture({ transientRetryMs: 500, retryDelaysMs: [5] });
  const loading = begin();
  response.resolve(new Response("guest upstream 502", { status: 502 }));
  await ready(router, loading);
  expect(requests).toHaveLength(1);
  const delivered = await router.fetch(navigation(url, loading), "loading-client");
  expect(delivered?.status).toBe(502);
  expect(await delivered?.text()).toBe("guest upstream 502");
});

test("transient preview-SW 502 stops retrying after the budget expires and delivers the final 502", async () => {
  const clients = new Map<string, { url: string }>();
  let calls = 0;
  const router = previewNavigations({
    scope,
    clients: { async get(id) { return clients.get(id); } },
    transientRetryMs: 30,
    retryDelaysMs: [10],
    async fetch() { calls++; return new Response("No bun.wasm server is listening on port 5173.\n", { status: 502, headers: { "x-bun-preview-transient": "1" } }); },
  });
  const redirect = router.fetch(navigation(url), "owner");
  if (!(redirect instanceof Response)) throw new Error("Expected redirect");
  const loading = redirect.headers.get("location")!;
  clients.set(loading, { url: loading });
  router.fetch(navigation(loading), "", loading);
  router.fetch(request(loading + "/status", loading), loading);
  await ready(router, loading);
  expect(calls).toBeGreaterThanOrEqual(2);
  const delivered = await router.fetch(navigation(url, loading), "loading-client");
  expect(delivered?.status).toBe(502);
  expect(await delivered?.text()).toContain("No bun.wasm server is listening");
});

test("cancelling a loading document during transient 502 backoff aborts further retries", async () => {
  const { router, requests, responses, begin } = fixture({ transientRetryMs: 500, retryDelaysMs: [200] });
  const loading = begin();
  let cancelled = false;
  responses[0]!.resolve(transient502(() => { cancelled = true; }));
  await Bun.sleep(15);
  expect((await router.fetch(request(loading + "/cancel/1", loading, "POST"), loading))?.status).toBe(204);
  await until(() => cancelled);
  await Bun.sleep(20);
  expect(requests).toHaveLength(1);
  expect((await status(router, loading)).status).toBe(410);
});

test("cancelling during the post-backoff client lookup prevents dispatching another guest fetch", async () => {
  const clients = new Map<string, { url: string }>();
  let lookups = 0;
  let fetches = 0;
  let cancelled = false;
  const secondLookup = Promise.withResolvers<void>();
  const releaseSecondLookup = Promise.withResolvers<void>();
  const router = previewNavigations({
    scope,
    transientRetryMs: 500,
    retryDelaysMs: [5],
    clients: {
      async get(id) {
        lookups++;
        if (lookups === 2) {
          secondLookup.resolve();
          await releaseSecondLookup.promise;
        }
        return clients.get(id);
      },
    },
    async fetch() {
      fetches++;
      return transient502(() => { cancelled = true; });
    },
  });
  const redirect = router.fetch(navigation(url), "owner");
  if (!(redirect instanceof Response)) throw new Error("Expected redirect");
  const loading = redirect.headers.get("location")!;
  clients.set(loading, { url: loading });
  router.fetch(navigation(loading), "", loading);
  router.fetch(request(loading + "/status", loading), loading);
  await secondLookup.promise;
  expect((await router.fetch(request(loading + "/cancel/1", loading, "POST"), loading))?.status).toBe(204);
  releaseSecondLookup.resolve();
  await until(() => cancelled);
  await Bun.sleep(20);
  expect(fetches).toBe(1);
});

test("budget expiring during backoff delivers the held 502 without dispatching an expired retry", async () => {
  const clients = new Map<string, { url: string }>();
  let fetches = 0;
  const router = previewNavigations({
    scope,
    transientRetryMs: 20,
    retryDelaysMs: [40],
    clients: { async get(id) { return clients.get(id); } },
    async fetch() {
      fetches++;
      return new Response(`transient-${fetches}`, { status: 502, headers: { "x-bun-preview-transient": "1" } });
    },
  });
  const redirect = router.fetch(navigation(url), "owner");
  if (!(redirect instanceof Response)) throw new Error("Expected redirect");
  const loading = redirect.headers.get("location")!;
  clients.set(loading, { url: loading });
  router.fetch(navigation(loading), "", loading);
  router.fetch(request(loading + "/status", loading), loading);
  await ready(router, loading);
  expect(fetches).toBe(1);
  const delivered = await router.fetch(navigation(url, loading), "loading-client");
  expect(delivered?.status).toBe(502);
  expect(await delivered?.text()).toBe("transient-1");
});
