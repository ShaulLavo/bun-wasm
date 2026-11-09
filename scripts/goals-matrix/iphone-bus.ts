import { installIphoneObserver } from "./iphone-browser";

type Page = { url: string; nonce: string; timeOrigin?: number; visible: boolean; userAgent?: string };
type Pending = { id: number; source: string; deadline: number; delivered: boolean; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Role = "host" | "preview";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected iPhone observer object");
  return value as Record<string, unknown>;
}
export class IphoneBus {
  private readonly pages = new Map<Role, Page>();
  private readonly pending = new Map<Role, Pending>();
  private sequence = 0;
  constructor(readonly path: string) {}
  configure(role: Role, url: string): void {
    this.cancel(role);
    this.pages.set(role, { url, nonce: crypto.randomUUID(), visible: false });
  }
  state(role: Role): Page | null { return this.pages.get(role) ?? null; }
  script(url: string, endpoint: string): string | undefined {
    const entry = Array.from(this.pages).find(([, page]) => page.url === url);
    if (!entry) return;
    const [role, page] = entry;
    if (page.timeOrigin !== undefined) throw new Error("Unexpected iPhone document replacement");
    const title = role === "host" ? `document.title = ${JSON.stringify("Goals " + page.nonce)};` : "";
    return title + `(${installIphoneObserver.toString()})(${JSON.stringify(endpoint + this.path + "/" + role + "/")},${JSON.stringify(page.nonce)});`;
  }
  inject(html: string, url: string, endpoint: string): string {
    const source = this.script(url, endpoint);
    if (!source) return html;
    const closing = Array.from(html.matchAll(/<\/body\s*>/gi)).at(-1)?.index;
    if (closing === undefined) throw new Error("iPhone observer needs closing body HTML");
    return html.slice(0, closing) + `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>` + html.slice(closing);
  }
  execute(role: Role, source: string, timeoutMs: number): Promise<unknown> {
    if (this.pending.has(role)) throw new Error("iPhone observer command already pending");
    const page = this.pages.get(role);
    if (!page?.timeOrigin) throw new Error("iPhone observer document not ready");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(role), timeoutMs);
      this.pending.set(role, { id, source, deadline: Date.now() + timeoutMs, delivered: false, resolve, reject, timer });
    });
  }
  private accept(role: Role, value: Record<string, unknown>, origin: string | null): Page {
    const page = this.pages.get(role);
    if (!page || origin !== new URL(page.url).origin || value.url !== page.url || value.nonce !== page.nonce
      || typeof value.timeOrigin !== "number" || !Number.isFinite(value.timeOrigin) || value.timeOrigin <= 0) throw new Error("Wrong iPhone observer document");
    if (page.timeOrigin !== undefined && page.timeOrigin !== value.timeOrigin) throw new Error("iPhone observer document replaced");
    page.timeOrigin = value.timeOrigin;
    return page;
  }
  poll(role: Role, value: unknown, origin: string | null): unknown {
    const row = object(value);
    const page = this.accept(role, row, origin);
    page.visible = row.visible === true;
    if (typeof row.userAgent === "string") page.userAgent = row.userAgent;
    const pending = this.pending.get(role);
    if (!pending || pending.delivered) return null;
    if (Date.now() >= pending.deadline) { this.cancel(role); return null; }
    pending.delivered = true;
    return { id: pending.id, source: pending.source, deadline: pending.deadline };
  }
  reply(role: Role, value: unknown, origin: string | null): void {
    const row = object(value);
    this.accept(role, row, origin);
    const pending = this.pending.get(role);
    if (!pending || !pending.delivered || row.id !== pending.id || Date.now() >= pending.deadline) throw new Error("Late or unordered iPhone observer reply");
    if (row.ok !== true && (row.ok !== false || typeof row.error !== "string")) throw new Error("Malformed iPhone observer reply");
    clearTimeout(pending.timer); this.pending.delete(role);
    if (row.ok === false) { pending.reject(new Error(String(row.error))); return; }
    pending.resolve(row.value);
  }
  cancel(role: Role): void {
    const pending = this.pending.get(role);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(role);
    pending.reject(new Error("iPhone observer command expired or closed"));
  }
  close(): void { this.cancel("host"); this.cancel("preview"); this.pages.clear(); }
  async handle(request: Request, productOrigin: string): Promise<Response> {
    const route = new URL(request.url).pathname.slice(this.path.length + 1);
    const headers = { "access-control-allow-origin": request.headers.get("origin") ?? "null", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET", "cache-control": "no-store", "vary": "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (route === "preview/script" && request.method === "GET") {
      const url = new URL(request.url).searchParams.get("url");
      if (!url || url !== this.state("preview")?.url || request.headers.get("origin") !== productOrigin) return new Response(null, { status: 204, headers });
      const source = this.script(url, new URL(request.url).origin);
      return new Response(source, { headers: { ...headers, "content-type": "text/javascript" } });
    }
    try { return Response.json(await this.route(route, request, productOrigin), { headers }); }
    catch (error) { return Response.json({ error: String(error) }, { status: 400, headers }); }
  }
  private async route(route: string, request: Request, productOrigin: string): Promise<unknown> {
    const [role, action] = route.split("/");
    if (role !== "host" && role !== "preview") throw new Error("Unknown iPhone page role");
    if (request.method === "GET" && action === "state") return this.state(role);
    const row = object(await request.json());
    if (action === "poll") return this.poll(role, row, request.headers.get("origin"));
    if (action === "reply") { this.reply(role, row, request.headers.get("origin")); return null; }
    if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) throw new Error("Controller-only iPhone operation");
    if (action === "configure" && typeof row.url === "string") {
      const url = new URL(row.url);
      if (role === "host") url.host = new URL(productOrigin).host;
      if (url.protocol !== "http:" || !(url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost"))) throw new Error("iPhone page must be loopback HTTP");
      this.configure(role, url.href); return url.href;
    }
    if (action === "execute" && typeof row.source === "string" && typeof row.timeoutMs === "number" && Number.isSafeInteger(row.timeoutMs) && row.timeoutMs > 0 && row.timeoutMs <= 900_000) return this.execute(role, row.source, row.timeoutMs);
    throw new Error("Unknown iPhone observer operation");
  }
}
