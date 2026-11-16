export type RoutingRow = Record<string, string | number | boolean | null>;
const routingTargets = ["/@vite/client", "/src/main.ts"];
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
    if (typeof row.kind !== "string" || typeof row.generation !== "string" || !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1) throw Error("Routing metadata has no valid event identity");
    if (Object.values(row).some(value => typeof value === "string" && value.length > 2048 || typeof value === "number" && !Number.isFinite(value))) throw Error("Routing metadata exceeded scalar bounds");
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
  snapshot() { return { coverage: this.coverage(), rows: this.rows.slice(), requests: this.requests.slice(), dropped: this.dropped, limit, boundary: this.boundary }; }
  summaries(): object[] {
    return routingTargets.map(target => this.summarize(target));
  }
  private summarize(target: string): object {
    const rows = this.rows.filter(row => Number(row.observed) > this.boundary && targetPath(row.target) === target);
    const requests = this.requests.filter(row => Number(row.observed) > this.boundary && path(row.url) === target && row.kind === "request");
    const forwards = rows.filter(row => row.kind === "forward");
    const base = { target, browserRequests: requests, candidates: this.candidateDetails(rows), joins: "unique target and port within observed restart window; no clock or cross-realm object-ID join" };
    if (!requests.length) return { ...base, firstIncomplete: "No observed browser request" };
    if (this.dropped || rows.some(row => Number(row.dropped) > 0)) return { ...base, firstIncomplete: "Unknown: routing retention or transport overflow", dropped: this.dropped };
    if (this.coverage().some(stream => stream.missing > 0)) return { ...base, firstIncomplete: "Unknown: routing stream coverage is missing", coverage: this.coverage() };
    if (requests.length !== 1 || forwards.length > 1) return { ...base, firstIncomplete: "Unknown: ambiguous same-target browser/SW join" };
    if (!forwards.length) {
      const fetches = this.rows.filter(row => Number(row.observed) > this.boundary && row.kind === "sw-fetch" && row.url === requests[0]!.url);
      if (fetches.length > 1) return { ...base, firstIncomplete: "Unknown: ambiguous browser/SW fetch join" };
      return { ...base, firstIncomplete: fetches.length ? "SW fetch observed; forward not observed" : "Unknown: browser request observed; no SW event observed" };
    }
    const forward = forwards[0]!;
    if (requests[0]!.url !== forward.url) return { ...base, firstIncomplete: "Unknown: browser and SW request URLs differ" };
    const worker = rows.filter(row => row.generation === forward.generation && row.ask === forward.ask);
    const candidates = worker.filter(row => row.kind === "claim-open");
    const replies = worker.filter(row => row.kind === "claim-reply");
    const explicit = worker.find(row => row.kind === "claim-post-failure" || row.kind === "claim-timeout" || row.kind === "claim-reply" && row.reply === "error");
    const refusal = replies.find(row => row.reply === "error");
    if (refusal) return { ...base, firstIncomplete: "SW received explicit server error", error: refusal.error };
    const heads = replies.filter(row => row.reply === "head");
    if (heads.length > 1) return { ...base, firstIncomplete: "Unknown: ambiguous response-head join", explicit };
    if (heads.length) return { ...base, firstIncomplete: replies.some(row => row.reply === "end" && row.channel === heads[0]!.channel) ? "Routing body completed; inspect native completion" : "Response head received; body completion not observed", explicit };
    if (replies.some(row => row.reply === "accepted")) return { ...base, firstIncomplete: "Accepted by SW; no response headers observed", explicit };
    if (worker.some(row => row.kind === "unavailable")) return { ...base, firstIncomplete: candidates.length ? "All observed candidates refused, expired or failed to post" : "Discovery completed without an eligible candidate", explicit };
    const pending = candidates.find(claim => !replies.some(reply => reply.channel === claim.channel));
    if (!pending) return { ...base, firstIncomplete: "SW forward observed; discovery or claim completion missing", explicit };
    if (!worker.some(row => row.kind === "claim-post" && row.channel === pending.channel)) return { ...base, firstIncomplete: "Claim opened; send call not observed", explicit };
    if (!worker.some(row => row.kind === "claim-post-return" && row.channel === pending.channel)) return { ...base, firstIncomplete: "Claim send called; return not observed", explicit };
    const page = rows.filter(row => row.realm === "page" && row.realmURL === pending.clientURL && row.port === forward.port);
    const received = page.filter(row => row.kind === "page-receive");
    if (received.length !== 1) return { ...base, firstIncomplete: received.length ? "Unknown: ambiguous page receipt join" : "Claim opened; actual page receipt not observed", explicit };
    const claimPage = pageClaimRows(page, received[0]!);
    if (!claimPage.length) return { ...base, firstIncomplete: "Unknown: page claim identity is incomplete", explicit };
    const dispatches = claimPage.filter(row => row.kind === "request-dispatch");
    if (dispatches.length > 1) return { ...base, firstIncomplete: "Unknown: ambiguous page dispatch join", explicit };
    const dispatched = dispatches[0];
    if (!dispatched) return { ...base, firstIncomplete: "Page received claim; registered-server dispatch not observed", explicit };
    if (dispatched.current === null) return { ...base, firstIncomplete: "Page received claim without a registered server", explicit };
    const helper = helperRows(this.rows, dispatched);
    const helperError = helper.find(row => row.kind === "helper-request-error");
    if (helperError) return { ...base, firstIncomplete: "Real helper.request threw", error: helperError.error, explicit };
    const returned = helper.filter(row => row.kind === "helper-request-return");
    if (returned.length !== 1) return { ...base, firstIncomplete: "Registered-server dispatch observed; real helper.request return missing or ambiguous", explicit };
    if (returned[0]!.accepted === false) return { ...base, firstIncomplete: "Real helper.request explicitly refused", explicit };
    const sendError = claimPage.find(row => row.kind === "page-send-error");
    if (sendError) return { ...base, firstIncomplete: "Page reply send threw", error: sendError.error, explicit };
    const sent = claimPage.find(row => row.kind === "page-send-return" && row.reply === "accepted");
    return { ...base, firstIncomplete: sent ? "Page acceptance send returned; SW receipt not observed" : "Real helper accepted; page acceptance send return not observed", explicit };
  }
  private candidateDetails(rows: RoutingRow[]) {
    const claims = rows.filter(row => row.kind === "claim-open");
    return { omitted: Math.max(0, claims.length - 16), items: claims.slice(0, 16).map(claim => {
      const worker = rows.filter(row => row.generation === claim.generation && row.ask === claim.ask && row.channel === claim.channel);
      const page = rows.filter(row => row.realm === "page" && row.realmURL === claim.clientURL && row.port === claim.port);
      const receipts = page.filter(row => row.kind === "page-receive");
      return { workerGeneration: claim.generation, claim: claim.channel, clientId: claim.clientId, clientURL: claim.clientURL,
        sendCalled: worker.some(row => row.kind === "claim-post"), sendReturned: worker.some(row => row.kind === "claim-post-return"),
        expired: worker.some(row => row.kind === "claim-timeout"), postFailed: worker.some(row => row.kind === "claim-post-failure"),
        replies: worker.filter(row => row.kind === "claim-reply" && row.reply !== "data").map(row => ({ reply: row.reply, status: row.status, error: row.error })),
        observedBodyChunks: progress(worker, "bodyChunks"), bodyProgress: "First chunk and terminal totals; intermediate chunks are not transported",
        page: receipts.length === 1 ? this.pageDetails(page, receipts[0]!) : { join: receipts.length ? "ambiguous same-target page receipts" : "page receipt not observed" } };
    }) };
  }
  private pageDetails(rows: RoutingRow[], receipt: RoutingRow) {
    const page = pageClaimRows(rows, receipt);
    const dispatches = page.filter(row => row.kind === "request-dispatch");
    if (dispatches.length !== 1) return { join: "Page dispatch missing or ambiguous" };
    const selected = dispatches[0]!;
    const helper = helperRows(this.rows, selected);
    return { join: "unique observed target, candidate URL and port", generation: receipt.generation, router: receipt.router, replyPort: receipt.replyPort,
      selectedServer: selected.current, realHelper: helper[0]?.helper,
      helperReturns: helper.filter(row => row.kind === "helper-request-return").map(row => row.accepted),
      helperErrors: helper.filter(row => row.kind === "helper-request-error").map(row => row.error),
      sendsCalled: page.filter(row => row.kind === "page-send").map(row => row.reply),
      sendsReturned: page.filter(row => row.kind === "page-send-return").map(row => row.reply),
      observedBodyCalls: progress(page, "bodyCalls"), observedBodyReturns: progress(page, "bodyReturns") };
  }
  private coverage() {
    const streams = new Map<string, number[]>();
    for (const row of this.rows) {
      const generation = String(row.generation);
      const sequence = Number(row.sequence);
      const stream = streams.get(generation) ?? [];
      stream.push(sequence); streams.set(generation, stream);
    }
    return Array.from(streams, ([generation, stream]) => {
      const maximum = Math.max(...stream);
      return { generation, received: stream.length, maximum, missing: maximum - stream.length, tail: "Unobserved realm termination can hide a tail" };
    });
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
    if (this.coverage().some(stream => stream.missing > 0)) throw Error("Routing stream coverage is missing");
  }
  private complete(forward: RoutingRow): boolean {
    if (this.rows.filter(row => row.kind === "forward" && row.url === forward.url).length !== 1) return false;
    const worker = this.rows.filter(row => row.generation === forward.generation && row.ask === forward.ask);
    const accepted = worker.filter(row => row.kind === "claim-reply" && row.reply === "head");
    return accepted.some(head => this.completeClaim(forward, head, worker));
  }
  private completeClaim(forward: RoutingRow, head: RoutingRow, worker: RoutingRow[]): boolean {
    if (!positiveId(head.channel) || !worker.some(row => row.kind === "claim-open" && row.channel === head.channel && row.clientURL === head.clientURL)) return false;
    if (!worker.some(row => row.kind === "claim-reply" && row.channel === head.channel && row.reply === "end")) return false;
    if (!this.nativeComplete(forward.url, head.status)) return false;
    const page = this.rows.filter(row => row.realm === "page" && row.realmURL === head.clientURL && row.target === forward.target && row.port === forward.port);
    const receipts = page.filter(row => row.kind === "page-receive");
    if (receipts.length !== 1) return false;
    const claimPage = pageClaimRows(page, receipts[0]!);
    const dispatches = claimPage.filter(row => row.kind === "request-dispatch" && positiveId(row.current) && positiveId(row.request));
    if (dispatches.length !== 1) return false;
    const dispatch = dispatches[0]!;
    const bound = this.rows.some(row => row.kind === "runtime-router" && row.generation === dispatch.generation && row.router === dispatch.router && positiveId(row.runtime));
    const helper = helperRows(this.rows, dispatch);
    return bound && helper.filter(row => row.kind === "helper-request-return" && row.accepted === true).length === 1
      && claimPage.some(row => row.kind === "page-send-return" && row.reply === "head");
  }
  private nativeComplete(url: RoutingRow[string] | undefined, status: RoutingRow[string] | undefined): boolean {
    if (typeof status !== "number") return false;
    const responses = this.requests.filter(row => row.kind === "response" && row.url === url && row.status === status && row.fromServiceWorker === true);
    if (responses.length !== 1) return false;
    const start = responses[0]!;
    if (!positiveId(start.page) || !positiveId(start.request)) return false;
    const lifecycle = this.requests.filter(row => row.url === url && row.page === start.page && row.request === start.request);
    return lifecycle.some(row => row.kind === "request")
      && lifecycle.some(row => row.kind === "requestfinished");
  }
}
function positiveId(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

function pageClaimRows(rows: RoutingRow[], receipt: RoutingRow): RoutingRow[] {
  if (!positiveId(receipt.router) || !positiveId(receipt.replyPort) || typeof receipt.realmURL !== "string" || !receipt.realmURL
    || typeof receipt.target !== "string" || !positiveId(receipt.port)) return [];
  return rows.filter(row => row.realm === "page" && row.generation === receipt.generation && row.realmURL === receipt.realmURL
    && row.router === receipt.router && row.replyPort === receipt.replyPort && row.target === receipt.target && row.port === receipt.port);
}

function helperRows(rows: RoutingRow[], dispatch: RoutingRow): RoutingRow[] {
  if (!positiveId(dispatch.request) || !positiveId(dispatch.current)) return [];
  const projections = rows.filter(row => row.kind === "helper-projection" && row.generation === dispatch.generation && row.capability === dispatch.current && positiveId(row.helper));
  if (projections.length !== 1) return [];
  return rows.filter(row => row.realm === "page" && row.generation === dispatch.generation && row.request === dispatch.request
    && row.helper === projections[0]!.helper && row.target === dispatch.target && row.port === dispatch.port);
}

function progress(rows: RoutingRow[], key: string): number {
  return Math.max(0, ...rows.map(row => typeof row[key] === "number" ? Number(row[key]) : 0));
}
function path(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try { const url = new URL(value); return url.pathname.replace(/^.*\/__preview\/\d+/, ""); }
  catch { return; }
}

function targetPath(value: unknown): string | undefined { return typeof value === "string" ? value.split("?")[0] : undefined; }
