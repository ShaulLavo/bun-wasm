interface NavigationOptions {
  scope: string;
  clients: { get(id: string): Promise<{ readonly url: string } | undefined> };
  fetch(request: Request, clientId: string): Promise<Response>;
}

type Reply = { kind: "waiting"; request: Request; clientId: string } | { kind: "pending" } | { kind: "ready"; response: Response } | { kind: "failed"; error: unknown };
interface Navigation { url: string; loadingURL: string; clientId: string; document: number; reply: Reply }

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
    if (navigation.reply.kind === "ready") cancelBody(navigation.reply.response);
  }

  async function hasLoadingClient(navigation: Navigation): Promise<boolean> {
    while (true) {
      const id = navigation.clientId;
      const client = await options.clients.get(id);
      if (id !== navigation.clientId) continue;
      if (!client) return false;
      const url = new URL(client.url);
      url.hash = "";
      return url.href === navigation.loadingURL;
    }
  }

  function waiting(navigation: Navigation, clientId: string): Response {
    if (!clientId) return new Response("Cannot bind the preview loading document.", { status: 400, headers });
    navigation.clientId = clientId;
    const input = JSON.stringify({ url: navigation.url, status: `${navigation.loadingURL}/status`, cancel: `${navigation.loadingURL}/cancel/${++navigation.document}` }).replaceAll("<", "\\u003c");
    const script = `(${waitForPreview.toString()})(${input});`;
    return new Response(`<!doctype html><meta charset="utf-8"><title>Loading preview</title><body><p role="status">Waiting for the development server…</p><script>${script}</script></body>`, {
      headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'" },
    });
  }

  function start(id: string, navigation: Navigation): void {
    if (navigation.reply.kind !== "waiting") return;
    const { request, clientId } = navigation.reply;
    navigation.reply = { kind: "pending" };
    void options.fetch(request, clientId).then(async response => {
      let live: boolean;
      try { live = await hasLoadingClient(navigation); }
      catch (error) { cancelBody(response); throw error; }
      if (pending.get(id) !== navigation) { cancelBody(response); return; }
      if (!live) { pending.delete(id); cancelBody(response); return; }
      navigation.reply = { kind: "ready", response };
    }).catch(error => { navigation.reply = { kind: "failed", error }; });
  }

  function cancelBody(response: Response): void { void response.body?.cancel().catch(() => {}); }

  function loadingRequest(request: Request, url: URL, clientId: string, resultingClientId: string): Response | undefined {
    const id = token(url.href);
    if (!id) return;
    const navigation = pending.get(id);
    if (!navigation) return new Response("Preview request is no longer available.", { status: 410, headers });
    if (url.href === navigation.loadingURL && request.mode === "navigate") return waiting(navigation, resultingClientId);
    if (request.referrer !== navigation.loadingURL || clientId !== navigation.clientId) return new Response(null, { status: 403, headers });
    if (url.href === `${navigation.loadingURL}/status` && request.method === "GET") {
      start(id, navigation);
      return Response.json({ ready: navigation.reply.kind === "ready" || navigation.reply.kind === "failed" }, { headers });
    }
    if (url.href.startsWith(`${navigation.loadingURL}/cancel/`) && request.method === "POST") {
      if (url.href === `${navigation.loadingURL}/cancel/${navigation.document}`) cancel(id, navigation);
      return new Response(null, { status: 204, headers });
    }
    return new Response(null, { status: 404, headers });
  }

  function begin(request: Request, clientId: string, url: string): Response {
    const id = crypto.randomUUID();
    const navigation: Navigation = { url, loadingURL: new URL(id, loading).href, clientId: "", document: 0, reply: { kind: "waiting", request, clientId } };
    pending.set(id, navigation);
    return redirect(navigation.loadingURL);
  }

  async function deliver(id: string, navigation: Navigation): Promise<Response> {
    const live = await hasLoadingClient(navigation);
    if (pending.get(id) !== navigation) return new Response(null, { status: 403, headers });
    if (!live) { cancel(id, navigation); return new Response(null, { status: 403, headers }); }
    if (navigation.reply.kind === "pending" || navigation.reply.kind === "waiting") return redirect(navigation.loadingURL);
    pending.delete(id);
    if (navigation.reply.kind === "failed") throw navigation.reply.error;
    return navigation.reply.response;
  }

  return {
    fetch(request: Request, clientId: string, resultingClientId = ""): Response | Promise<Response> | undefined {
      const url = new URL(request.url);
      url.hash = "";
      if (url.origin !== scope.origin) return;
      if (url.pathname.startsWith(loading.pathname)) return loadingRequest(request, url, clientId, resultingClientId);
      if (request.mode !== "navigate" || request.method !== "GET" || !guest.test(url.pathname)) return;
      const id = token(request.referrer);
      const navigation = id ? pending.get(id) : undefined;
      if (!id || !navigation || navigation.url !== url.href) return begin(request, clientId, url.href);
      return deliver(id, navigation);
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
      if (state && typeof state === "object" && "ready" in state && state.ready === true) {
        navigating = true;
        const target = new URL(input.url);
        target.hash = location.hash;
        location.replace(target.href);
        return;
      }
      setTimeout(() => { void poll(); }, 250);
    } catch {
      const message = document.querySelector('[role="status"]');
      if (message) message.textContent = "The preview request failed. Reload to try again.";
    }
  }
  void poll();
}
