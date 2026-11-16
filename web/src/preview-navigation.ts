interface NavigationOptions {
  scope: string;
  fetch(request: Request, clientId: string): Promise<Response>;
}

type Reply = { kind: "pending" } | { kind: "ready"; response: Response } | { kind: "failed"; error: unknown };
interface Navigation { url: string; loadingURL: string; reply: Reply }

/** A loading document keeps a slow guest request outside WebKit's fetch-head watchdog. */
export function previewNavigations(options: NavigationOptions) {
  const scope = new URL(options.scope);
  const loading = new URL(".loading/", scope);
  const pending = new Map<string, Navigation>();
  const guest = new RegExp(`^${scope.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{1,5}(?:/|$)`);
  const headers = {
    "cache-control": "no-store",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "same-origin",
  };
  const redirect = (url: string) => new Response(null, { status: 307, headers: { ...headers, location: url } });

  function token(url: string): string | undefined {
    if (!url) return;
    const parsed = new URL(url);
    if (parsed.origin !== loading.origin || !parsed.pathname.startsWith(loading.pathname)) return;
    return parsed.pathname.slice(loading.pathname.length).split("/")[0];
  }

  function cancel(id: string, navigation: Navigation): void {
    pending.delete(id);
    if (navigation.reply.kind === "ready") void navigation.reply.response.body?.cancel().catch(() => {});
  }

  function waiting(navigation: Navigation): Response {
    const input = JSON.stringify({ url: navigation.url, status: `${navigation.loadingURL}/status`, cancel: `${navigation.loadingURL}/cancel` }).replaceAll("<", "\\u003c");
    const script = `(${waitForPreview.toString()})(${input});`;
    return new Response(`<!doctype html><meta charset="utf-8"><title>Loading preview</title><body><p role="status">Waiting for the development server…</p><script>${script}</script></body>`, {
      headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'" },
    });
  }

  function loadingRequest(request: Request, url: URL): Response | undefined {
    const id = token(url.href);
    if (!id) return;
    const navigation = pending.get(id);
    if (!navigation) return new Response("Preview request is no longer available.", { status: 410, headers });
    if (url.href === navigation.loadingURL && request.mode === "navigate") return waiting(navigation);
    if (request.referrer !== navigation.loadingURL) return new Response(null, { status: 403, headers });
    if (url.href === `${navigation.loadingURL}/status` && request.method === "GET") return Response.json({ ready: navigation.reply.kind !== "pending" }, { headers });
    if (url.href === `${navigation.loadingURL}/cancel` && request.method === "POST") { cancel(id, navigation); return new Response(null, { status: 204, headers }); }
    return new Response(null, { status: 404, headers });
  }

  function begin(request: Request, clientId: string): Response {
    const id = crypto.randomUUID();
    const navigation: Navigation = { url: request.url, loadingURL: new URL(id, loading).href, reply: { kind: "pending" } };
    pending.set(id, navigation);
    void options.fetch(request, clientId).then(response => {
      if (pending.get(id) !== navigation) { void response.body?.cancel().catch(() => {}); return; }
      navigation.reply = { kind: "ready", response };
    }, error => { navigation.reply = { kind: "failed", error }; });
    return redirect(navigation.loadingURL);
  }

  return {
    fetch(request: Request, clientId: string): Response | Promise<Response> | undefined {
      const url = new URL(request.url);
      if (url.origin !== scope.origin) return;
      if (url.pathname.startsWith(loading.pathname)) return loadingRequest(request, url);
      if (request.mode !== "navigate" || request.method !== "GET" || !guest.test(url.pathname)) return;
      const id = token(request.referrer);
      const navigation = id ? pending.get(id) : undefined;
      if (!id || !navigation || navigation.url !== url.href) return begin(request, clientId);
      if (navigation.reply.kind === "pending") return redirect(navigation.loadingURL);
      pending.delete(id);
      return navigation.reply.kind === "ready" ? navigation.reply.response : Promise.reject(navigation.reply.error);
    },
  };
}

/** Serialized into the temporary same-origin loading document. */
function waitForPreview(input: { url: string; status: string; cancel: string }): void {
  let navigating = false;
  let stopped = false;
  addEventListener("pagehide", () => {
    stopped = true;
    if (!navigating) void fetch(input.cancel, { method: "POST", keepalive: true }).catch(() => {});
  }, { once: true });
  async function poll(): Promise<void> {
    try {
      const response = await fetch(input.status, { cache: "no-store" });
      if (!response.ok) throw new Error("The preview request is no longer available.");
      const state: unknown = await response.json();
      if (stopped) return;
      if (state && typeof state === "object" && "ready" in state && state.ready === true) { navigating = true; location.replace(input.url); return; }
      setTimeout(() => { void poll(); }, 250);
    } catch {
      const message = document.querySelector('[role="status"]');
      if (message) message.textContent = "The preview request failed. Reload to try again.";
    }
  }
  void poll();
}
