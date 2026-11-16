type Page = { readonly url: string; readonly nonce: string };
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
  close(): void { this.grants.clear(); this.rows.length = 0; }
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
    Object.assign(row, grant, { serverAt: Date.now(), currentNonce: page?.nonce ?? null, sameConfiguration: page?.url === grant.url && page.nonce === grant.nonce });
    this.rows.push(row);
    this.emit?.(row);
    return new Response(null, { status: 204, headers });
  }
  private start(value: Record<string, unknown>, page: Page | null, headers: Record<string, string>): Response {
    if (!page || value.url !== page.url || (value.method !== "GET" && value.method !== "HEAD") || this.grants.size >= 32) return new Response(null, { status: 204, headers });
    const grant = { id: crypto.randomUUID(), url: page.url, nonce: page.nonce, method: value.method };
    this.grants.set(grant.id, grant);
    return Response.json(grant, { headers });
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
