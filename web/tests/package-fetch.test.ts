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

test("packageFetch rewrites tarball and metadata URLs through a host proxy hook", async () => {
  const seen: Array<{ url: string; kind: string }> = [];
  const { calls, fetcher } = createFetcher(() => new Response("proxied-archive"));
  const original = "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.23/waffle-base-0.0.23.tgz";
  const result = await packageFetch(original, {}, fetcher, {
    kind: "tarball",
    rewriteUrl(request) {
      seen.push(request);
      return `https://sprockt.invalid/api/tarball-proxy?url=${encodeURIComponent(request.url)}`;
    },
  });

  expect(await result.text()).toBe("proxied-archive");
  expect(seen).toEqual([{ url: original, kind: "tarball" }]);
  expect(calls).toHaveLength(1);
  expect(required(calls[0]).url).toBe(`https://sprockt.invalid/api/tarball-proxy?url=${encodeURIComponent(original)}`);
});

test("packageFetch resolves same-origin relative proxy paths and passes through nullish rewrites", async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://sprockt.invalid/workspace/1" } });
  try {
    const { calls, fetcher } = createFetcher(() => new Response("ok"));
    await packageFetch("https://github.com/ShaulLavo/waffle/releases/download/v1/pkg.tgz", {}, fetcher, {
      kind: "tarball",
      rewriteUrl: ({ url }) => `/api/proxy?url=${encodeURIComponent(url)}`,
    });
    await packageFetch("https://registry.invalid/evlog", {}, fetcher, {
      kind: "metadata",
      rewriteUrl: () => undefined,
    });
    expect(required(calls[0]).url).toBe(
      `https://sprockt.invalid/api/proxy?url=${encodeURIComponent("https://github.com/ShaulLavo/waffle/releases/download/v1/pkg.tgz")}`,
    );
    expect(required(calls[1]).url).toBe("https://registry.invalid/evlog");
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("packageFetch rejects empty or non-http(s) rewritten package URLs", async () => {
  const { calls, fetcher } = createFetcher(() => new Response("never"));
  for (const bad of ["", "   ", "javascript:alert(1)", "file:///etc/passwd", "https://user:pass@proxy.invalid/pkg.tgz"]) {
    await expect(packageFetch("https://registry.invalid/pkg.tgz", {}, fetcher, {
      kind: "tarball",
      rewriteUrl: () => bad,
    })).rejects.toThrow(TypeError);
  }
  expect(calls).toHaveLength(0);
});

test("packageFetch preserves credential headers on same-origin rewrites", async () => {
  const { calls, fetcher } = createFetcher(() => new Response("same-origin-rewrite"));
  const result = await packageFetch("https://registry.invalid:444/pkg.tgz", { headers: credentialValues }, fetcher, {
    kind: "tarball",
    rewriteUrl: ({ url }) => `https://registry.invalid:444/proxy?url=${encodeURIComponent(url)}`,
  });

  expect(await result.text()).toBe("same-origin-rewrite");
  expect(calls).toHaveLength(1);
  for (const name of credentialHeaders) expect(required(calls[0]).headers.get(name)).toBe(credentialValues[name]);
});

test("packageFetch strips all credential headers before the first request on cross-origin rewrites", async () => {
  const { calls, fetcher } = createFetcher(() => new Response("cross-origin-rewrite"));
  const result = await packageFetch("https://private.registry.invalid/pkg.tgz", { headers: credentialValues }, fetcher, {
    kind: "tarball",
    rewriteUrl: ({ url }) => `https://sprockt.invalid/api/tarball-proxy?url=${encodeURIComponent(url)}`,
  });

  expect(await result.text()).toBe("cross-origin-rewrite");
  expect(calls).toHaveLength(1);
  expect(required(calls[0]).url).toBe(
    `https://sprockt.invalid/api/tarball-proxy?url=${encodeURIComponent("https://private.registry.invalid/pkg.tgz")}`,
  );
  expectCredentialHeaders(required(calls[0]).headers, null);
});

test("packageFetch preserves redacted hop URL when a redirected transport request rejects", async () => {
  const { calls, fetcher } = createFetcher(currentCalls => {
    if (currentCalls.length === 1) return redirectResponse("https://cdn.invalid/disconnected.tgz", () => {});
    throw new TypeError("fetch failed");
  });
  await expect(
    packageFetch("https://origin.invalid/start.tgz", {}, fetcher, {
      kind: "tarball",
      rewriteUrl: ({ url }) => (url.startsWith("https://cdn.invalid/")
        ? `https://proxy.invalid/tarball?url=${encodeURIComponent(url)}`
        : null),
    }),
  ).rejects.toThrow("GET https://proxy.invalid/tarball - fetch failed");
  expect(calls).toHaveLength(2);
});
