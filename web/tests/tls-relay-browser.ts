import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Response as BrowserResponse } from "playwright";
import { guestArtifacts, readVerifiedFile, recheckDependencies, tlsLoaded, verifyReviewedHostSource, type ObservedResponse, type TlsIntake } from "../../scripts/tls-qualification-inputs.ts";
import { qualificationCases, assertCaseContext, isCase, type QualificationEngine } from "../../scripts/tls-qualification-context.ts";
import { acquireOwned, deadline, type TlsCleanup } from "../../scripts/tls-qualification-lifecycle.ts";
import { type startTlsServices } from "./tls-relay-services.ts";

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
export async function runTlsBrowser(intake: TlsIntake, services: Awaited<ReturnType<typeof startTlsServices>>, owner: TlsCleanup, engine: QualificationEngine, signal: AbortSignal) {
  signal.throwIfAborted();
  const options = intake.fixtures;
  // Only sealed, preflighted members are served; nothing is built or read from the host checkout here.
  const pageMembers = new Map(intake.page.map(row => [relative(intake.handoff.tlsPageRoot, row.path), row]));
  const seeds = new Map(intake.dependencies.pg.files.map(row => [`node_modules/${relative(intake.dependencies.pg.root, row.path)}`, row]));
  const origin = `http://127.0.0.1:${options.pagePort}`;
  const asset = guestAsset(intake, engine, origin);
  const selectedArtifacts = guestArtifacts(intake.handoff, engine);
  for (const file of selectedArtifacts.concat(intake.page, [intake.handoff.artifacts.tlsPgClient])) await readVerifiedFile(file);
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
    if (url.pathname === "/pg-client.ts") return new Response(await readVerifiedFile(intake.handoff.artifacts.tlsPgClient), { headers });
    const seed = url.pathname.startsWith("/seed/") ? seeds.get(url.pathname.slice("/seed/".length)) : undefined;
    if (seed) return new Response(await readVerifiedFile(seed), { headers });
    const artifact = selectedArtifacts.find(file => url.pathname === `/artifact/${file.sha256}`);
    if (artifact) return new Response(await readVerifiedFile(artifact), { headers: { ...headers, "Content-Type": "application/wasm" } });
    const member = pageMembers.get(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    if (!member) return new Response(null, { status: 404 });
    return new Response(await readVerifiedFile(member), { headers: { ...headers, "Content-Type": Bun.file(member.path).type } });
  }
  async function post(request: Request, path: string): Promise<Response> {
    if (request.headers.get("origin") !== origin || signal.aborted) return new Response(null, { status: 403 });
    if (path === "/lifecycle") return Response.json(services.lifecycle(), { headers });
    if (path === "/token") return new Response(await services.token(), { headers });
    const mode = path.slice("/case/".length);
    if (!path.startsWith("/case/") || !isCase(mode)) return new Response(null, { status: 404 });
    services.select(mode);
    return Response.json({ engine, asset, ca: services.ca, password: services.password, endpoint: `http://127.0.0.1:${options.relayPort}` }, { headers });
  }
  signal.throwIfAborted();
  await recheckDependencies(intake);
  signal.throwIfAborted();
  await verifyReviewedHostSource(intake.hostSource, intake.source);
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
  signal.throwIfAborted();
  await page.goto(origin);
  await page.waitForFunction(() => !!Reflect.get(globalThis, "tlsQualification"));
  const rows = [];
  for (const mode of qualificationCases) {
    const raw = await deadline(page.evaluate(mode => Reflect.get(globalThis, "tlsQualification").runCase(mode), mode), signal, 90_000);
    rows.push({ ...assertCaseContext(raw, mode, engine), wire: await services.audit(mode) });
  }
  const { loaded, unloaded } = tlsLoaded(intake.handoff, await Promise.all(responses));
  return { ok: true, browser: "chromium", version: browser.version(), engine, carrier: "websocket", rows, loaded, unloaded, seedIdentities: intake.dependencies.pg.files,
    preflightReferences: intake.references, pgArchive: intake.pgArchive, frozenLocks: intake.dependencies.locks, hostDependencies: intake.dependencies.host, source: intake.source, tuple: intake.tuple, guestAsset: asset, pageMembers: intake.page, trustScope: "run-generated-extra-CA; not bundled-public-roots", verificationBarrier: "armed native TLS destination saw zero startup/password bytes on trust-failure controls; SSL rejection sent only SSLRequest" };
}
