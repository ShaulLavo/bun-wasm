export type RoutingRow = Record<string, string | number | boolean | null>;
export const routingTargets = ["/@vite/client", "/src/main.ts"];
const limit = 4096;
export class StorageRoutingEvidence {
  readonly rows: RoutingRow[] = [];
  private dropped = 0;
  private native = 0;
  private readonly requests: RoutingRow[] = [];
  private boundary = 0;
  receive(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid routing metadata");
    if (Object.values(value).some(item => item !== null && !["string", "number", "boolean"].includes(typeof item))) throw Error("Routing metadata contains non-scalar data");
    const row = value as RoutingRow;
    if (typeof row.kind !== "string") throw Error("Routing metadata has no event kind");
    if (this.rows.some(existing => existing.generation === row.generation && existing.sequence === row.sequence)) return;
    if (this.rows.length === limit) { this.rows.shift(); this.dropped++; }
    this.rows.push({ ...row, observed: ++this.native });
  }
  request(value: RoutingRow): void {
    if (!routingTargets.concat(["/"]).includes(path(value.url) ?? "")) return;
    if (this.requests.length === 128) { this.requests.shift(); this.dropped++; }
    this.requests.push({ ...value, observed: ++this.native });
  }
  beginRestart(): void { this.boundary = this.native; }
  snapshot(): object { return { rows: this.rows.slice(), requests: this.requests.slice(), dropped: this.dropped, limit, boundary: this.boundary }; }
  summaries(): object[] {
    return routingTargets.map(target => this.summarize(target));
  }
  private summarize(target: string): object {
    const rows = this.rows.filter(row => Number(row.observed) > this.boundary && targetPath(row.target) === target);
    const requests = this.requests.filter(row => Number(row.observed) > this.boundary && path(row.url) === target && row.kind === "request");
    const forwards = rows.filter(row => row.kind === "forward");
    const base = { target, browserRequests: requests, joins: "unique target and port within observed restart window; no clock or cross-realm object-ID join" };
    if (!requests.length) return { ...base, firstIncomplete: "No observed browser request" };
    if (this.dropped || rows.some(row => Number(row.dropped) > 0)) return { ...base, firstIncomplete: "Unknown: routing retention or transport overflow", dropped: this.dropped };
    if (!forwards.length) return { ...base, firstIncomplete: "Browser request observed; no SW forward observed", swFetch: this.rows.some(row => row.kind === "sw-fetch" && requests.some(request => request.url === row.url)) };
    if (requests.length !== 1 || forwards.length !== 1) return { ...base, firstIncomplete: "Unknown: ambiguous same-target browser/SW join" };
    const forward = forwards[0]!;
    if (requests[0]!.url !== forward.url) return { ...base, firstIncomplete: "Unknown: browser and SW request URLs differ" };
    const worker = rows.filter(row => row.generation === forward.generation && row.ask === forward.ask);
    const candidates = worker.filter(row => row.kind === "claim-open");
    const replies = worker.filter(row => row.kind === "claim-reply");
    const explicit = worker.find(row => row.kind === "claim-post-failure" || row.kind === "claim-timeout" || row.kind === "claim-reply" && row.reply === "error");
    if (replies.some(row => row.reply === "head")) return { ...base, firstIncomplete: replies.some(row => row.reply === "end") ? "Routing body completed; inspect native completion" : "Response head received; body completion not observed", explicit };
    if (replies.some(row => row.reply === "accepted")) return { ...base, firstIncomplete: "Accepted by SW; no response headers observed", explicit };
    if (worker.some(row => row.kind === "unavailable")) return { ...base, firstIncomplete: candidates.length ? "All observed candidates refused, expired or failed to post" : "Discovery completed without an eligible candidate", explicit };
    const pending = candidates.find(claim => !replies.some(reply => reply.channel === claim.channel));
    if (!pending) return { ...base, firstIncomplete: "SW forward observed; discovery or claim completion missing", explicit };
    if (!worker.some(row => row.kind === "claim-post" && row.channel === pending.channel)) return { ...base, firstIncomplete: "Claim opened; send call not observed", explicit };
    if (!worker.some(row => row.kind === "claim-post-return" && row.channel === pending.channel)) return { ...base, firstIncomplete: "Claim send called; return not observed", explicit };
    const page = rows.filter(row => row.realm === "page" && row.realmURL === pending.clientURL && row.port === forward.port);
    const received = page.filter(row => row.kind === "page-receive");
    if (received.length !== 1) return { ...base, firstIncomplete: received.length ? "Unknown: ambiguous page receipt join" : "Claim opened; actual page receipt not observed", explicit };
    const dispatched = page.find(row => row.kind === "request-dispatch");
    if (!dispatched) return { ...base, firstIncomplete: "Page received claim; registered-server dispatch not observed", explicit };
    if (dispatched.current === null) return { ...base, firstIncomplete: "Page received claim without a registered server", explicit };
    const projection = this.rows.find(row => row.kind === "helper-projection" && row.generation === dispatched.generation && row.capability === dispatched.current);
    const helperError = page.find(row => row.kind === "helper-request-error" && row.request === dispatched.request && row.helper === projection?.helper);
    if (helperError) return { ...base, firstIncomplete: "Real helper.request threw", error: helperError.error, explicit };
    const helper = page.filter(row => row.kind === "helper-request-return" && row.request === dispatched.request && row.helper === projection?.helper);
    if (helper.length !== 1) return { ...base, firstIncomplete: "Registered-server dispatch observed; real helper.request return missing or ambiguous", explicit };
    if (helper[0]!.accepted === false) return { ...base, firstIncomplete: "Real helper.request explicitly refused", explicit };
    const sent = page.find(row => row.kind === "page-send-return" && row.reply === "accepted");
    return { ...base, firstIncomplete: sent ? "Page acceptance send returned; SW receipt not observed" : "Real helper accepted; page acceptance send return not observed", explicit };
  }
  qualify(targets = routingTargets): void {
    for (const target of targets) this.qualifyTarget(target);
  }
  private qualifyTarget(target: string): void {
    const forward = this.rows.filter(row => row.kind === "forward" && targetPath(row.target) === target);
    if (!forward.length) throw Error(`Routing coverage missing SW forward for ${target}`);
    const complete = forward.some(row => this.complete(row));
    if (!complete) throw Error(`Routing coverage missing actual page/runtime/helper and SW head/end for ${target}`);
    if (this.dropped || this.rows.some(row => Number(row.dropped) > 0)) throw Error("Routing coverage overflowed");
  }
  private complete(forward: RoutingRow): boolean {
    const worker = this.rows.filter(row => row.generation === forward.generation && row.ask === forward.ask);
    const accepted = worker.filter(row => row.kind === "claim-reply" && row.reply === "head");
    return accepted.some(head => this.completeClaim(forward, head, worker));
  }
  private completeClaim(forward: RoutingRow, head: RoutingRow, worker: RoutingRow[]): boolean {
    if (!worker.some(row => row.kind === "claim-reply" && row.channel === head.channel && row.reply === "end")) return false;
    if (!this.requests.some(row => row.kind === "response" && row.url === forward.url && row.fromServiceWorker === true)) return false;
    if (!this.requests.some(row => row.kind === "requestfinished" && row.url === forward.url)) return false;
    const page = this.rows.filter(row => row.realm === "page" && row.realmURL === head.clientURL && row.target === forward.target && row.port === forward.port);
    const dispatches = page.filter(row => row.kind === "request-dispatch" && row.current !== null);
    if (dispatches.length !== 1) return false;
    const dispatch = dispatches[0]!;
    const bound = this.rows.some(row => row.kind === "runtime-router" && row.generation === dispatch.generation && row.router === dispatch.router);
    const projection = this.rows.find(row => row.kind === "helper-projection" && row.generation === dispatch.generation && row.capability === dispatch.current);
    return bound && !!projection && page.some(row => row.kind === "helper-request-return" && row.helper === projection.helper && row.request === dispatch.request && row.accepted === true)
      && page.some(row => row.kind === "page-receive" && row.router === dispatch.router)
      && page.some(row => row.kind === "page-send-return" && row.reply === "head");
  }
}
function path(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try { const url = new URL(value); return url.pathname.replace(/^.*\/__preview\/\d+/, ""); }
  catch { return; }
}

function targetPath(value: unknown): string | undefined { return typeof value === "string" ? value.split("?")[0] : undefined; }
