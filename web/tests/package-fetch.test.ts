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

test("packageFetch rejects empty, malformed, credential-bearing, or non-http(s) rewritten URLs without echoing them", async () => {
  const { calls, fetcher } = createFetcher(() => new Response("never"));
  for (const bad of ["", "   ", "javascript:alert(1)", "file:///etc/passwd", "https://user:pass@proxy.invalid/pkg.tgz"]) {
    await expect(packageFetch("https://registry.invalid/pkg.tgz", {}, fetcher, {
      kind: "tarball",
      rewriteUrl: () => bad,
    })).rejects.toThrow(TypeError);
  }
  const sensitiveCases: ReadonlyArray<{ url: string | URL; forbidden: readonly string[] }> = [
    {
      url: "https://user:secret-pass@proxy.invalid/pkg.tgz?token=secret-token#secret-frag",
      forbidden: ["user", "secret-pass", "secret-token", "secret-frag", "proxy.invalid"],
    },
    {
      url: "https://proxy.invalid/pkg.tgz?:_authToken=secret-token",
      forbidden: ["_authToken", "secret-token", "proxy.invalid"],
    },
    {
      url: "data:text/plain,secret-data-payload",
      forbidden: ["data:", "secret-data-payload"],
    },
    {
      url: new URL("data:text/plain;base64,c2VjcmV0LXVybC1wYXlsb2Fk"),
      forbidden: ["data:", "c2VjcmV0LXVybC1wYXlsb2Fk"],
    },
    {
      url: "http://[::1/secret-malformed?token=secret-token",
      forbidden: ["[::1", "secret-malformed", "secret-token"],
    },
    {
      url: "://secret-malformed-host/pkg.tgz",
      forbidden: ["secret-malformed-host", "pkg.tgz"],
    },
    {
      url: "/relative-without-base/secret-path?token=secret-token",
      forbidden: ["relative-without-base", "secret-path", "secret-token"],
    },
  ];
  for (const { url, forbidden } of sensitiveCases) {
    let thrown: unknown;
    try {
      await packageFetch("https://registry.invalid/pkg.tgz", {}, fetcher, {
        kind: "tarball",
        rewriteUrl: () => url,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    if (!(thrown instanceof TypeError)) throw new Error("Expected TypeError");
    expect("input" in thrown).toBe(false);
    expect(thrown.cause).toBeUndefined();
    for (const token of forbidden) {
      expect(thrown.message).not.toContain(token);
    }
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

test("packageFetch preserves redacted proxy URL when a first-hop rewritten request rejects", async () => {
  const { calls, fetcher } = createFetcher(() => {
    throw new TypeError("fetch failed");
  });
  await expect(
    packageFetch("https://github.com/org/repo/releases/download/v1/pkg.tgz", {}, fetcher, {
      kind: "tarball",
      rewriteUrl: ({ url }) => `https://proxy.invalid/tarball?url=${encodeURIComponent(url)}`,
    }),
  ).rejects.toThrow("GET https://proxy.invalid/tarball - fetch failed");
  expect(calls).toHaveLength(1);
});

test("packageFetch populates redacted response.url for synthetic error responses from a proxy", async () => {
  const { fetcher } = createFetcher(() => new Response(null, { status: 404 }));
  const response = await packageFetch("https://github.com/org/repo/releases/download/v1/pkg.tgz", {}, fetcher, {
    kind: "tarball",
    rewriteUrl: ({ url }) => `https://proxy.invalid/tarball?url=${encodeURIComponent(url)}`,
  });
  expect(response.status).toBe(404);
  expect(response.url).toBe("https://proxy.invalid/tarball");
});

test("packageFetch forwards explicit credentials from a structured rewrite result", async () => {
  const seenCredentials: Array<RequestCredentials | undefined> = [];
  const fetcher = Object.assign(async (_input: FetchInput, init?: FetchInit) => {
    seenCredentials.push(init?.credentials);
    return new Response("ok");
  }, { preconnect: fetch.preconnect });
  await packageFetch("https://registry.invalid/direct.tgz", {}, fetcher);
  await packageFetch("https://github.com/org/repo/releases/download/v1/pkg.tgz", {}, fetcher, {
    kind: "tarball",
    rewriteUrl: ({ url }) => ({ url: `https://proxy.invalid/tarball?url=${encodeURIComponent(url)}`, credentials: "omit" }),
  });
  expect(seenCredentials).toEqual([undefined, "omit"]);
});

test("packageFetch includes redacted proxy URL in opaqueredirect errors", async () => {
  const opaque = Object.defineProperty(new Response(null, { status: 200 }), "type", { value: "opaqueredirect" });
  const { fetcher } = createFetcher(() => opaque);
  await expect(
    packageFetch("https://github.com/org/repo/releases/download/v1/pkg.tgz", {}, fetcher, {
      kind: "tarball",
      rewriteUrl: ({ url }) => `https://proxy.invalid/tarball?url=${encodeURIComponent(url)}`,
    }),
  ).rejects.toThrow("GET https://proxy.invalid/tarball - Package redirect destination is unavailable to this browser");
});

function createCredentialsFetcher(
  handler: (seen: Array<RequestCredentials | undefined>) => Response | Promise<Response>,
): { seen: Array<RequestCredentials | undefined>; fetcher: typeof fetch } {
  const seen: Array<RequestCredentials | undefined> = [];
  const implementation = async (_input: FetchInput, init?: FetchInit) => {
    seen.push(init?.credentials);
    return handler(seen);
  };
  return { seen, fetcher: Object.assign(implementation, { preconnect: fetch.preconnect }) };
}

test("packageFetch carries explicit credentials omit across same-origin and cross-origin redirects", async () => {
  const { seen, fetcher } = createCredentialsFetcher(calls => {
    if (calls.length === 1) return redirectResponse("https://app.invalid/blob.tgz", () => {});
    if (calls.length === 2) return redirectResponse("https://cdn.invalid/final.tgz", () => {});
    return new Response("blob");
  });
  const response = await packageFetch("https://github.com/org/repo/releases/download/v1/pkg.tgz", {}, fetcher, {
    kind: "tarball",
    rewriteUrl: ({ url }) => (url.startsWith("https://github.com/")
      ? { url: `https://app.invalid/proxy?url=${encodeURIComponent(url)}`, credentials: "omit" }
      : null),
  });
  expect(await response.text()).toBe("blob");
  expect(seen).toEqual(["omit", "omit", "omit"]);
});

test("packageFetch preserves explicit credentials include on same-origin redirects and resets across origins", async () => {
  const sameOrigin = createCredentialsFetcher(calls => (
    calls.length === 1 ? redirectResponse("/blob.tgz", () => {}) : new Response("same-origin-blob")
  ));
  const sameOriginResponse = await packageFetch("https://github.com/org/repo/releases/download/v1/pkg.tgz", {}, sameOrigin.fetcher, {
    kind: "tarball",
    rewriteUrl: ({ url }) => (url.startsWith("https://github.com/")
      ? { url: `https://proxy.invalid/tarball?url=${encodeURIComponent(url)}`, credentials: "include" }
      : null),
  });
  expect(await sameOriginResponse.text()).toBe("same-origin-blob");
  expect(sameOrigin.seen).toEqual(["include", "include"]);

  const crossOrigin = createCredentialsFetcher(calls => {
    if (calls.length === 1) return redirectResponse("https://cdn.invalid/hop.tgz", () => {});
    if (calls.length === 2) return redirectResponse("https://proxy.invalid/bounce.tgz", () => {});
    return new Response("cross-origin-blob");
  });
  const crossOriginResponse = await packageFetch("https://github.com/org/repo/releases/download/v1/pkg.tgz", {}, crossOrigin.fetcher, {
    kind: "tarball",
    rewriteUrl: ({ url }) => (url.startsWith("https://github.com/")
      ? { url: `https://proxy.invalid/tarball?url=${encodeURIComponent(url)}`, credentials: "include" }
      : null),
  });
  expect(await crossOriginResponse.text()).toBe("cross-origin-blob");
  expect(crossOrigin.seen).toEqual(["include", undefined, undefined]);

  const rewriteOriginChange = createCredentialsFetcher(calls => (
    calls.length === 1 ? redirectResponse("/next.tgz", () => {}) : new Response("other-proxy-blob")
  ));
  const rewriteOriginChangeResponse = await packageFetch(
    "https://github.com/org/repo/releases/download/v1/pkg.tgz",
    {},
    rewriteOriginChange.fetcher,
    {
      kind: "tarball",
      rewriteUrl: ({ url }) => {
        if (url.startsWith("https://github.com/")) {
          return { url: `https://proxy-a.invalid/tarball?url=${encodeURIComponent(url)}`, credentials: "include" };
        }
        if (url === "https://proxy-a.invalid/next.tgz") return "https://proxy-b.invalid/next.tgz";
        return null;
      },
    },
  );
  expect(await rewriteOriginChangeResponse.text()).toBe("other-proxy-blob");
  expect(rewriteOriginChange.seen).toEqual(["include", undefined]);

  const downgrade = createCredentialsFetcher(calls => {
    if (calls.length === 1) return redirectResponse("/public-hop.tgz", () => {});
    if (calls.length === 2) return redirectResponse("/public-final.tgz", () => {});
    return new Response("downgraded-blob");
  });
  const downgradeResponse = await packageFetch("https://github.com/org/repo/releases/download/v1/pkg.tgz", {}, downgrade.fetcher, {
    kind: "tarball",
    rewriteUrl: ({ url }) => {
      if (url.startsWith("https://github.com/")) {
        return { url: `https://proxy.invalid/tarball?url=${encodeURIComponent(url)}`, credentials: "include" };
      }
      if (url === "https://proxy.invalid/public-hop.tgz") {
        return { url: "https://proxy.invalid/public-anon.tgz", credentials: "omit" };
      }
      return null;
    },
  });
  expect(await downgradeResponse.text()).toBe("downgraded-blob");
  expect(downgrade.seen).toEqual(["include", "omit", "omit"]);
});
