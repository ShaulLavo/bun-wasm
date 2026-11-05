import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page, Response as BrowserResponse } from "playwright";
import type { RuntimeWorkerMessage } from "waffle/browser/worker";
import { guestArtifacts, object, readVerifiedFile, recheckDependencies, tlsLoaded, verifyReviewedHostSource, type ObservedResponse, type TlsIntake } from "../../scripts/tls-qualification-inputs.ts";
import { qualificationCases, assertCaseContext, isCase, type QualificationCase, type QualificationEngine } from "../../scripts/tls-qualification-context.ts";
import { acquireOwned, deadline, type TlsCleanup } from "../../scripts/tls-qualification-lifecycle.ts";
import { type startTlsServices } from "./tls-relay-services.ts";
import type { RunSecrets } from "../../tests/servers/tls.ts";

/** The page binding the guest observer reports through. Host-side only: the sealed page never reads it. */
export const GUEST_OBSERVER_BINDING = "bunWasmTlsGuestObserver";
const GUEST_TEXT_LIMIT = 2048;
const GUEST_LIST_LIMIT = 32;
const GUEST_ARMING_MS = 5000;
const guestTypes: readonly string[] = ["phase", "stdout", "stderr", "exit", "error", "cleanup-error", "worker-error"];

/**
 * Runs in the page before any of its scripts, through Playwright's init
 * script, so the served sealed members and their bundle stay byte-identical.
 * Every page-level Worker gets one more `message` and `error` listener; the
 * page's own handlers still receive every event unchanged. Each waffle
 * RuntimeWorkerMessage that carries guest evidence (phase, stdout, stderr,
 * exit, error, cleanup-error) is reduced to its declared fields and sent to
 * the host binding in order. A failed send is counted where the host reads
 * it, never dropped silently. Self-contained: Playwright sends its source.
 */
export function installGuestObserver(binding: string): void {
  const NativeWorker = globalThis.Worker;
  const forward: unknown = Reflect.get(globalThis, binding);
  if (typeof NativeWorker !== "function" || typeof forward !== "function") throw new Error("TLS guest observer needs Worker and its host binding");
  const state = { sent: 0, failed: 0, firstFailure: "" };
  Reflect.set(globalThis, `${binding}State`, state);
  let workers = 0;
  const send = (row: Record<string, unknown>) => {
    state.sent++;
    Promise.resolve(forward({ ...row, seq: state.sent })).catch((error: unknown) => { state.failed++; state.firstFailure ||= String(error); });
  };
  const reduce = (message: RuntimeWorkerMessage, decoders: Record<"stdout" | "stderr", TextDecoder>): Record<string, unknown> | undefined => {
    if (message.type === "phase") return { type: message.type, name: message.name };
    if (message.type === "stdout" || message.type === "stderr") return { type: message.type, bytes: message.data.byteLength, text: decoders[message.type].decode(message.data, { stream: true }) };
    if (message.type === "exit") return { type: message.type, code: message.code, signal: message.signal ?? null, cleanupErrors: message.cleanupErrors ?? [] };
    if (message.type === "error") return { type: message.type, code: message.code, errno: message.errno ?? null, message: message.message, cleanupErrors: message.cleanupErrors ?? [] };
    if (message.type === "cleanup-error") return { type: message.type, code: message.code, signal: message.signal ?? null, message: message.message, cleanupErrors: message.cleanupErrors };
    return undefined;
  };
  const observe = (target: Worker, url: string) => {
    const worker = ++workers;
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    target.addEventListener("message", event => {
      const data: unknown = event.data;
      const row = data && typeof data === "object" && "type" in data ? reduce(data as RuntimeWorkerMessage, decoders) : undefined;
      if (row) send({ worker, path: url, ...row });
    });
    target.addEventListener("error", event => send({ worker, path: url, type: "worker-error", message: event.message, location: `${event.filename}:${event.lineno}:${event.colno}` }));
  };
  class ObservedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      observe(this, String(url));
    }
  }
  Reflect.set(globalThis, "Worker", ObservedWorker);
}

/** Redacts exact run secrets first, then bounds, so a cut never leaves part of a secret. */
function boundedText(text: string, secrets: RunSecrets): string {
  const redacted = secrets.redact(text);
  if (redacted.length <= GUEST_TEXT_LIMIT) return redacted;
  return `${redacted.slice(0, GUEST_TEXT_LIMIT)}... [${redacted.length - GUEST_TEXT_LIMIT} more characters]`;
}
type GuestField = string | number | null | string[];
function guestField(value: unknown, secrets: RunSecrets): GuestField {
  if (typeof value === "string") return boundedText(value, secrets);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!Array.isArray(value)) return null;
  return value.slice(0, GUEST_LIST_LIMIT).map(item => boundedText(String(item), secrets));
}
/** One page-level worker's messages during one case: phases, output tails and terminal messages. */
class WorkerObservation {
  readonly phases: string[] = [];
  readonly terminal: Record<string, GuestField>[] = [];
  readonly bytes = { stdout: 0, stderr: 0 };
  readonly output: Record<"stdout" | "stderr", ReturnType<RunSecrets["tail"]>>;
  constructor(readonly worker: number, readonly path: string, secrets: RunSecrets) {
    this.output = { stdout: secrets.tail(GUEST_TEXT_LIMIT), stderr: secrets.tail(GUEST_TEXT_LIMIT) };
  }
  evidence() {
    return { worker: this.worker, path: this.path, phases: this.phases, terminal: this.terminal,
      stdout: { bytes: this.bytes.stdout, tail: this.output.stdout.read() }, stderr: { bytes: this.bytes.stderr, tail: this.output.stderr.read() } };
  }
}
class CaseObservation {
  readonly armed = Promise.withResolvers<void>();
  controlWorker: number | null = null;
  unarmed: string | null = null;
  private readonly workers = new Map<number, WorkerObservation>();
  constructor(readonly mode: QualificationCase, private readonly secrets: RunSecrets) {}
  record(row: Record<string, unknown>, type: string, worker: number): void {
    const observed = this.worker(worker, row.path);
    if (type === "stdout" || type === "stderr") {
      observed.bytes[type] += typeof row.bytes === "number" ? row.bytes : 0;
      observed.output[type].write(typeof row.text === "string" ? row.text : "");
      return;
    }
    if (type !== "phase") {
      if (observed.terminal.length < GUEST_LIST_LIMIT) observed.terminal.push(this.terminal(type, row));
      return;
    }
    const name = guestField(row.name, this.secrets);
    if (observed.phases.length < GUEST_LIST_LIMIT) observed.phases.push(String(name));
    if (name !== "worker-start" || this.controlWorker !== null) return;
    this.controlWorker = worker;
    this.armed.resolve();
  }
  evidence() { return Array.from(this.workers.values(), worker => worker.evidence()); }
  private worker(id: number, path: unknown): WorkerObservation {
    let observed = this.workers.get(id);
    if (!observed) this.workers.set(id, observed = new WorkerObservation(id, String(guestField(path, this.secrets)), this.secrets));
    return observed;
  }
  private terminal(type: string, row: Record<string, unknown>): Record<string, GuestField> {
    const terminal: Record<string, GuestField> = { type };
    for (const key of ["code", "signal", "errno", "message", "cleanupErrors", "location"]) if (key in row) terminal[key] = guestField(row[key], this.secrets);
    return terminal;
  }
}
/**
 * The host side of the guest observer. Records attribute to the case the page
 * last asked for. Its positive control is the guest root worker's own
 * `worker-start` phase, which waffle posts on the same message channel as
 * stdout, stderr and exit before the guest runs: the relay token is issued
 * only after that control was seen for the current case, so no PostgreSQL
 * connection is attempted through an observer that is not armed.
 */
export class GuestObserver {
  private current: CaseObservation | undefined;
  private received = 0;
  private lastSeq = 0;
  private gaps = 0;
  private unattributed = 0;
  private waiting: { count: number; resolve: () => void } | undefined;
  constructor(private readonly secrets: RunSecrets, private readonly armingMs = GUEST_ARMING_MS) {}
  begin(mode: QualificationCase): void { this.current = new CaseObservation(mode, this.secrets); }
  accept(raw: unknown): void {
    const row = object(raw, "guest observer record");
    const { seq, worker, type } = row;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= this.lastSeq || typeof worker !== "number" || !Number.isSafeInteger(worker)
      || typeof type !== "string" || !guestTypes.includes(type)) throw new Error("Invalid guest observer record");
    this.gaps += seq - this.lastSeq - 1;
    this.lastSeq = seq;
    this.received++;
    if (this.waiting && this.received >= this.waiting.count) this.waiting.resolve();
    if (!this.current) { this.unattributed++; return; }
    this.current.record(row, type, worker);
  }
  /** Resolves once the current case's control was observed; otherwise names the missing control. */
  async requireArmed(signal: AbortSignal): Promise<void> {
    const current = this.current;
    if (!current) throw new Error("TLS guest observer has no current case");
    try { await deadline(current.armed.promise, signal, this.armingMs); }
    catch (error) {
      current.unarmed ??= `no worker-start phase from a page worker within ${this.armingMs} ms of the ${current.mode} case: ${String(error)}`;
      throw new Error(`TLS guest observer did not arm: ${current.unarmed}`, { cause: error });
    }
  }
  /** Waits, bounded, until the host received as many records as the page reports sent. */
  async drained(count: number, signal: AbortSignal): Promise<void> {
    if (this.received >= count) return;
    const reached = Promise.withResolvers<void>();
    this.waiting = { count, resolve: reached.resolve };
    try { await deadline(reached.promise, signal, 2000); } finally { this.waiting = undefined; }
  }
  evidence(mode: QualificationCase, page: unknown, delivery: string | null) {
    const current = this.current?.mode === mode ? this.current : undefined;
    return { mode, observed: current !== undefined, positiveControl: { phase: "worker-start", worker: current?.controlWorker ?? null, unarmed: current?.unarmed ?? null },
      host: { received: this.received, gaps: this.gaps, unattributed: this.unattributed, delivery }, page, workers: current?.evidence() ?? [] };
  }
}
/** The relay token, only after the current case's observer control was seen. Unarmed: refused, so the guest never connects. */
export async function guardedToken(observer: GuestObserver, signal: AbortSignal, issue: () => Promise<string>, headers: HeadersInit): Promise<Response> {
  try { await observer.requireArmed(signal); }
  catch { return new Response(null, { status: 403, headers }); }
  return new Response(await issue(), { headers });
}
/** A guest case the page reported failed: which case, and what the observer saw, with the page's own error as the cause. */
export class TlsGuestCaseFailure extends Error {
  override readonly name = "TlsGuestCaseFailure";
  constructor(readonly mode: QualificationCase, readonly guest: string, cause: unknown) {
    super(`TLS ${mode} case failed in the browser; guest exit, error and output are in guest`, { cause });
  }
}
type PageState = { sent: number; failed: number; firstFailure: string };
function pageState(value: unknown): PageState {
  const row = object(value, "page guest observer state");
  if (typeof row.sent !== "number" || typeof row.failed !== "number" || typeof row.firstFailure !== "string") throw new Error("Invalid page guest observer state");
  return { sent: row.sent, failed: row.failed, firstFailure: row.firstFailure };
}
/** Collects the failed case's evidence. Never replaces the page's error: a failed read is itself recorded. */
export async function guestCaseFailure(observer: GuestObserver, mode: QualificationCase, cause: unknown, readPage: () => Promise<unknown>, secrets: RunSecrets): Promise<TlsGuestCaseFailure> {
  const reading = new AbortController();
  let page: PageState | { readError: string };
  let delivery: string | null = null;
  try {
    const state = pageState(await deadline(readPage(), reading.signal, 2000));
    page = { ...state, firstFailure: boundedText(state.firstFailure, secrets) };
    await observer.drained(state.sent, reading.signal).catch((error: unknown) => { delivery = `host received fewer records than the page sent: ${String(error)}`; });
  } catch (error) { page = { readError: boundedText(String(error), secrets) }; }
  return new TlsGuestCaseFailure(mode, JSON.stringify(observer.evidence(mode, page, delivery)), cause);
}
function readPageObserver(page: Page): Promise<unknown> {
  return page.evaluate(name => Reflect.get(globalThis, name), `${GUEST_OBSERVER_BINDING}State`);
}

function guestAsset(intake: TlsIntake, engine: QualificationEngine, origin: string) {
  const files = guestArtifacts(intake.handoff, engine).map(row => ({ url: `${origin}/artifact/${row.sha256}`, sha256: row.sha256, bytes: row.bytes }));
  const core = files[0];
  if (!core) throw new Error("Missing TLS core");
  if (engine === "browser") return { kind: "single", core };
  const side = files[1];
  if (!side) throw new Error("Missing TLS engine program");
  return { kind: engine, core, side };
}
/** A real response as the page or one of its workers received it: decoded body and Content-Encoding. */
async function observe(response: BrowserResponse): Promise<ObservedResponse> {
  return { url: response.url(), method: response.request().method(), status: response.status(), contentEncoding: response.headers()["content-encoding"], body: await response.body() };
}
export async function verifyTlsBrowserHost(intake: Pick<TlsIntake, "hostSource" | "harness">): Promise<void> {
  await verifyReviewedHostSource(intake.hostSource, intake.harness.source);
}
export async function runTlsBrowser(intake: TlsIntake, services: Awaited<ReturnType<typeof startTlsServices>>, owner: TlsCleanup, engine: QualificationEngine, signal: AbortSignal, secrets: RunSecrets) {
  signal.throwIfAborted();
  const observer = new GuestObserver(secrets);
  const options = intake.fixtures;
  const sealedRoot = intake.handoff.delivery.root;
  // Only sealed, preflighted members are served; nothing is built or read from the host checkout here.
  const pageMembers = new Map(intake.page.map(row => [relative(intake.handoff.tlsPageRoot, row.path), row]));
  const seeds = new Map(intake.dependencies.pg.files.map(row => [`node_modules/${relative(intake.dependencies.pg.root, row.path)}`, row]));
  const origin = `http://127.0.0.1:${options.pagePort}`;
  const asset = guestAsset(intake, engine, origin);
  const selectedArtifacts = guestArtifacts(intake.handoff, engine);
  for (const file of selectedArtifacts.concat(intake.page, [intake.handoff.artifacts.tlsPgClient])) await readVerifiedFile(file, sealedRoot);
  const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  await acquireOwned(owner, signal, () => Bun.serve({ hostname: "127.0.0.1", port: options.pagePort, fetch: respond }), async server => {
    await server.stop(true);
    if (server.pendingRequests || server.pendingWebSockets) throw new Error("TLS page listener cleanup unconfirmed");
  });
  async function respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response(null, { status: 403 });
    if (request.method === "POST") return post(request, url.pathname);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (url.pathname === "/seed") return Response.json(Array.from(seeds.keys()), { headers });
    if (url.pathname === "/pg-client.ts") return new Response(await readVerifiedFile(intake.handoff.artifacts.tlsPgClient, sealedRoot), { headers });
    const seed = url.pathname.startsWith("/seed/") ? seeds.get(url.pathname.slice("/seed/".length)) : undefined;
    if (seed) return new Response(await readVerifiedFile(seed), { headers });
    const artifact = selectedArtifacts.find(file => url.pathname === `/artifact/${file.sha256}`);
    if (artifact) return new Response(await readVerifiedFile(artifact, sealedRoot), { headers: { ...headers, "Content-Type": "application/wasm" } });
    const member = pageMembers.get(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    if (!member) return new Response(null, { status: 404 });
    return new Response(await readVerifiedFile(member, sealedRoot), { headers: { ...headers, "Content-Type": Bun.file(member.path).type } });
  }
  async function post(request: Request, path: string): Promise<Response> {
    if (request.headers.get("origin") !== origin || signal.aborted) return new Response(null, { status: 403 });
    if (path === "/lifecycle") return Response.json(services.lifecycle(), { headers });
    if (path === "/token") return guardedToken(observer, signal, () => services.token(), headers);
    const mode = path.slice("/case/".length);
    if (!path.startsWith("/case/") || !isCase(mode)) return new Response(null, { status: 404 });
    services.select(mode);
    observer.begin(mode);
    return Response.json({ engine, asset, ca: services.ca, password: services.password, endpoint: `http://127.0.0.1:${options.relayPort}` }, { headers });
  }
  signal.throwIfAborted();
  await recheckDependencies(intake);
  signal.throwIfAborted();
  await verifyTlsBrowserHost(intake);
  const playwright: typeof import("playwright") = await import(pathToFileURL(Bun.resolveSync("playwright", intake.hostSource)).href);
  const browser = await acquireOwned(owner, signal, () => playwright.chromium.launch({ headless: true }), browser => browser.close());
  let cancellationClose: Promise<void> | undefined;
  const stopBrowser = () => { cancellationClose ??= browser.close(); void cancellationClose.catch(() => {}); };
  signal.addEventListener("abort", stopBrowser, { once: true });
  owner.add(async () => { signal.removeEventListener("abort", stopBrowser); await cancellationClose; });
  if (signal.aborted) stopBrowser();
  const context = await acquireOwned(owner, signal, () => browser.newContext(), context => context.close());
  const responses: Promise<ObservedResponse>[] = [];
  context.on("response", response => {
    // POST control responses carry run credentials and are never loaded objects; their bodies are not read.
    if (response.request().method() !== "GET") return;
    const pending = observe(response);
    pending.catch(() => {});
    responses.push(pending);
  });
  const page = await acquireOwned(owner, signal, () => context.newPage(), async page => {
    if (!page.isClosed()) await page.evaluate(async () => { const api = Reflect.get(globalThis, "tlsQualification"); if (api) await api.cancel(); });
    await page.close();
  });
  // The observer is injected by the host before the page's own scripts; the served page bytes are unchanged.
  await page.exposeFunction(GUEST_OBSERVER_BINDING, (row: unknown) => { observer.accept(row); });
  await page.addInitScript(installGuestObserver, GUEST_OBSERVER_BINDING);
  signal.throwIfAborted();
  await page.goto(origin);
  await page.waitForFunction(() => !!Reflect.get(globalThis, "tlsQualification"));
  if (!await readPageObserver(page)) throw new Error("TLS guest observer was not installed before the page's scripts");
  const rows = [];
  for (const mode of qualificationCases) {
    const raw = await deadline(page.evaluate(mode => Reflect.get(globalThis, "tlsQualification").runCase(mode), mode), signal, 90_000)
      .catch(async (error: unknown) => { throw await guestCaseFailure(observer, mode, error, () => readPageObserver(page), secrets); });
    rows.push({ ...assertCaseContext(raw, mode, engine), wire: await services.audit(mode) });
  }
  const { loaded, unloaded } = tlsLoaded(intake.handoff, await Promise.all(responses));
  return { ok: true, browser: "chromium", version: browser.version(), engine, carrier: "websocket", rows, loaded, unloaded, seedIdentities: intake.dependencies.pg.files,
    preflightReferences: intake.references, pgArchive: intake.pgArchive, frozenLocks: intake.dependencies.locks, hostDependencies: intake.dependencies.host, source: intake.source, tuple: intake.tuple, guestAsset: asset, pageMembers: intake.page, trustScope: "run-generated-extra-CA; not bundled-public-roots", verificationBarrier: "armed native TLS destination saw zero startup/password bytes on trust-failure controls; SSL rejection sent only SSLRequest" };
}
