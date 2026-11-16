type Page = { readonly url: string; readonly nonce: string; readonly issued: boolean };
type Scalar = string | number | boolean | null;
type Grant = { readonly id: string; readonly nonce: string; readonly url: string; readonly method: string };
export type IphoneResponseObservation = Readonly<Record<string, Scalar>>;
const events = new Set(["request", "head", "observer-fetch-start", "observer-fetch-end", "observer-body-end", "body-start", "body-end", "transform-end", "failure"]);
const fields = new Set(["event", "sequence", "clientAt", "status", "contentType", "contentEncoding", "contentLength", "contentSecurityPolicy", "frameOptions", "embedderPolicy", "resourcePolicy", "characters", "stage", "error"]);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected scalar response event");
  return Object.fromEntries(Object.entries(value));
}

export class IphoneResponses {
  private readonly grants = new Map<string, Grant>();
  private readonly rows: IphoneResponseObservation[] = [];
  constructor(private readonly page: () => Page | null, private readonly emit?: (row: IphoneResponseObservation) => void) {}
  configure(): void { this.grants.clear(); }
  close(): void { this.grants.clear(); this.rows.length = 0; }
  scriptNonce(id: string, url: string): string | undefined {
    return this.reserve({ id, url, method: "GET" }, this.page())?.nonce;
  }
  async handle(request: Request, origin: string): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/state")) {
      if (request.method !== "GET" || request.headers.has("origin") || request.headers.has("sec-fetch-site")) return new Response(null, { status: 403 });
      return Response.json(this.rows);
    }
    const headers = { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
    if (request.headers.get("origin") !== origin) return new Response(null, { status: 403, headers });
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "POST") return new Response(null, { status: 405, headers });
    const value = record(await request.json());
    const page = this.page();
    if (path.endsWith("/start")) return this.start(value, page, headers);
    if (!path.endsWith("/event")) return new Response(null, { status: 404, headers });
    const grant = typeof value.id === "string" ? this.grants.get(value.id) : undefined;
    if (!grant || value.nonce !== grant.nonce || value.url !== grant.url) return new Response(null, { status: 403, headers });
    const row = this.event(value);
    Object.assign(row, grant, { serverAt: Date.now(), currentNonce: page?.nonce ?? null, sameConfiguration: page?.url === grant.url });
    this.rows.push(row);
    this.emit?.(row);
    return new Response(null, { status: 204, headers });
  }
  private start(value: Record<string, unknown>, page: Page | null, headers: Record<string, string>): Response {
    const grant = this.reserve(value, page);
    return grant ? Response.json(grant, { headers }) : new Response(null, { status: 204, headers });
  }
  private reserve(value: Record<string, unknown>, page: Page | null): Grant | undefined {
    if (!page || value.url !== page.url || (value.method !== "GET" && value.method !== "HEAD") || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id)) return;
    const previous = this.grants.get(value.id);
    if (previous) return previous.method === value.method ? previous : undefined;
    if (this.grants.size >= 32) return;
    const nonce = page.issued || this.grants.size > 0 ? crypto.randomUUID() : page.nonce;
    const grant = { id: value.id, url: page.url, nonce, method: value.method };
    this.grants.set(grant.id, grant);
    return grant;
  }
  private event(value: Record<string, unknown>): Record<string, Scalar> {
    if (typeof value.event !== "string" || !events.has(value.event) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || Number(value.sequence) > 16 || this.rows.length >= 256) throw new Error("Invalid or excessive response event");
    const row: Record<string, Scalar> = {};
    for (const key of fields) this.field(row, key, value[key]);
    return row;
  }
  private field(row: Record<string, Scalar>, key: string, value: unknown): void {
    if (value === undefined) return;
    if (value !== null && typeof value !== "string" && typeof value !== "number") throw new Error("Non-scalar response event");
    if (typeof value === "string" && value.length > 2048 || typeof value === "number" && !Number.isFinite(value)) throw new Error("Oversized response event");
    row[key] = value;
  }
}
