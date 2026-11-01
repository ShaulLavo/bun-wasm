import { expect, test } from "bun:test";
import { packageFetch } from "../src/net/package-fetch";

const credentialHeaders = ["authorization", "proxy-authorization", "cookie", "cookie2", "www-authenticate"] as const;
const credentialValues = {
  authorization: "Bearer fixture-token",
  "proxy-authorization": "Basic fixture-proxy",
  cookie: "fixture-cookie=1",
  cookie2: "fixture-cookie-two=1",
  "www-authenticate": "Bearer fixture-challenge",
};

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchCall = { url: string; headers: Headers; redirect: RequestRedirect | undefined };

function inputUrl(input: Request | string | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a recorded fetch call");
  return value;
}

function recordCall(calls: FetchCall[], input: FetchInput, init: FetchInit) {
  calls.push({ url: inputUrl(input), headers: new Headers(init?.headers), redirect: init?.redirect });
}

function createFetcher(handler: (calls: FetchCall[]) => Response | Promise<Response>): { calls: FetchCall[]; fetcher: typeof fetch } {
  const calls: FetchCall[] = [];
  const implementation = async (input: FetchInput, init: FetchInit) => {
    recordCall(calls, input, init);
    return handler(calls);
  };
  return { calls, fetcher: Object.assign(implementation, { preconnect: fetch.preconnect }) };
}

function expectCredentialHeaders(headers: Headers, value: string | null) {
  for (const name of credentialHeaders) expect(headers.get(name)).toBe(value);
}

function redirectResponse(location: string, onCancel: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({ cancel() { onCancel(); } }), { status: 302, headers: { location } });
}

test("packageFetch preserves credential headers across a same-origin redirect and cancels its body", async () => {
  let cancelled = false;
  const { calls, fetcher } = createFetcher(currentCalls => {
    if (currentCalls.length === 1) return redirectResponse("/archive", () => { cancelled = true; });
    return new Response("same-origin archive");
  });
  const result = await packageFetch("https://registry.invalid:444/metadata", { headers: credentialValues }, fetcher);

  expect(await result.text()).toBe("same-origin archive");
  expect(calls).toHaveLength(2);
  expect(required(calls[0]).redirect).toBe("manual");
  expect(required(calls[1]).url).toBe("https://registry.invalid:444/archive");
  for (const name of credentialHeaders) expect(required(calls[1]).headers.get(name)).toBe(credentialValues[name]);
  expect(cancelled).toBe(true);
});

test("packageFetch removes all credential headers across a full-origin redirect", async () => {
  const { calls, fetcher } = createFetcher(currentCalls => {
    if (currentCalls.length === 1) return redirectResponse("https://registry.invalid:445/archive", () => {});
    return new Response("full-origin archive");
  });
  const result = await packageFetch("https://registry.invalid:444/metadata", { headers: credentialValues }, fetcher);

  expect(await result.text()).toBe("full-origin archive");
  expect(calls).toHaveLength(2);
  expect(required(calls[1]).url).toBe("https://registry.invalid:445/archive");
  expectCredentialHeaders(required(calls[1]).headers, null);
});

test("packageFetch removes all credential headers across a scheme change with a held port", async () => {
  const { calls, fetcher } = createFetcher(currentCalls => {
    if (currentCalls.length === 1) return redirectResponse("http://registry.invalid:444/archive", () => {});
    return new Response("scheme-change archive");
  });
  const result = await packageFetch("https://registry.invalid:444/metadata", { headers: credentialValues }, fetcher);

  expect(await result.text()).toBe("scheme-change archive");
  expect(calls).toHaveLength(2);
  expect(required(calls[1]).url).toBe("http://registry.invalid:444/archive");
  expectCredentialHeaders(required(calls[1]).headers, null);
});

test("packageFetch rejects an unsafe redirect before a second request", async () => {
  let cancelled = false;
  const { calls, fetcher } = createFetcher(() => {
    return redirectResponse("/archive?authToken=fixture", () => { cancelled = true; });
  });
  const request = packageFetch("https://registry.invalid:444/metadata", { headers: credentialValues }, fetcher);

  await expect(request).rejects.toThrow("Credential-bearing or unsupported package redirect URL");
  expect(calls).toHaveLength(1);
  expect(cancelled).toBe(true);
});

test("packageFetch returns a redirect response without a Location header", async () => {
  const response = new Response("redirect payload", { status: 302 });
  const { calls, fetcher } = createFetcher(() => response);
  const result = await packageFetch("https://registry.invalid/metadata", {}, fetcher);

  expect(result).toBe(response);
  expect(await result.text()).toBe("redirect payload");
  expect(calls).toHaveLength(1);
});

test("packageFetch returns an ordinary successful final response", async () => {
  const { calls, fetcher } = createFetcher(() => new Response("final response", { status: 200 }));
  const result = await packageFetch("https://registry.invalid/metadata", {}, fetcher);

  expect(result.status).toBe(200);
  expect(await result.text()).toBe("final response");
  expect(calls).toHaveLength(1);
});

test("packageFetch enforces the redirect limit after cancelling each redirect body", async () => {
  const { calls, fetcher } = createFetcher(currentCalls => redirectResponse(`/hop-${currentCalls.length}`, () => {}));
  const request = packageFetch("https://registry.invalid/metadata", {}, fetcher);

  await expect(request).rejects.toThrow("Package response redirected too many times");
  expect(calls).toHaveLength(21);
});
