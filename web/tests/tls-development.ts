import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { buildBrowserEntries } from "../../scripts/browser-build.ts";
import { TLS_PAGE_ENTRY, TLS_PAGE_INDEX, TLS_PAGE_WORKERS } from "../../scripts/c1/tls-page.ts";
import { RunSecrets, TlsQualificationFailure, formatTlsFailure } from "../../scripts/tls-qualification.ts";
import { TlsCleanup, acquireOwned, deadline } from "../../scripts/tls-qualification-lifecycle.ts";
import { assertCaseContext, isCase } from "../../scripts/tls-qualification-context.ts";
import { GUEST_OBSERVER_BINDING, GuestObserver, guardedToken, guestCaseFailure, installGuestObserver } from "./tls-relay-browser.ts";
import { startTlsFixtureServices } from "./tls-relay-services.ts";

const hostSource = resolve(import.meta.dir, "../..");
const ports = { pagePort: 43839, relayPort: 43840 };
const origin = `http://127.0.0.1:${ports.pagePort}`;
const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
type Recorder = (row: object) => Promise<void>;
type Options = ReturnType<typeof developmentArguments>;
type Services = Awaited<ReturnType<typeof startTlsFixtureServices>>;

export function developmentArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flag || !["--wasm", "--pg-modules", "--output", "--case"].includes(flag) || !value || values.has(flag)) throw new Error("Expected --wasm PATH --pg-modules PATH --output PATH [--case no-extra-ca]");
    values.set(flag, value);
  }
  const path = (key: string) => {
    const value = values.get(key);
    if (!value || !isAbsolute(value) || resolve(value) !== value) throw new Error(`${key} requires a canonical absolute path`);
    return value;
  };
  const mode = values.get("--case") ?? "no-extra-ca";
  if (!isCase(mode)) throw new Error("Unknown PostgreSQL TLS case");
  return { wasm: path("--wasm"), pgModules: path("--pg-modules"), output: path("--output"), mode };
}
async function seedFiles(root: string, path = ""): Promise<string[]> {
  let files: string[] = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const name = join(path, entry.name);
    if (entry.isDirectory()) files = files.concat(await seedFiles(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error("PostgreSQL development seed must contain ordinary files");
  }
  return files;
}
function tool(name: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`Missing development fixture tool ${name}`);
  return path;
}
async function developmentInputs(options: Options, owner: TlsCleanup, signal: AbortSignal, record: Recorder) {
  const pg: unknown = JSON.parse(await readFile(join(options.pgModules, "pg/package.json"), "utf8"));
  if (!pg || typeof pg !== "object" || !("version" in pg) || pg.version !== "8.16.3") throw new Error("Development fixture requires pg 8.16.3");
  const seeds = new Map((await seedFiles(options.pgModules)).map(path => [`node_modules/${path}`, join(options.pgModules, path)]));
  const scratch = await acquireOwned(owner, signal, () => mkdtemp(join(tmpdir(), "bwt-")), path => rm(path, { recursive: true, force: true }));
  await record({ kind: "development-scratch", path: scratch });
  const pageRoot = join(scratch, "page");
  await buildBrowserEntries([TLS_PAGE_ENTRY].concat(TLS_PAGE_WORKERS).map(path => join(hostSource, path)), pageRoot, { runtimeWorker: true });
  await writeFile(join(pageRoot, "index.html"), TLS_PAGE_INDEX);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(options.wasm)) hash.update(chunk);
  const asset = { kind: "single", core: { url: `${origin}/guest.wasm`, sha256: hash.digest("hex"), bytes: Bun.file(options.wasm).size } };
  await record({ kind: "development-guest", path: options.wasm, ...asset.core });
  const files = new Map((await seedFiles(pageRoot)).map(path => [`/${path}`, join(pageRoot, path)]));
  files.set("/", join(pageRoot, "index.html"));
  files.set("/guest.wasm", options.wasm);
  files.set("/pg-client.ts", join(hostSource, "web/tests/fixtures/tls/pg-client.ts"));
  return { files, seeds, asset };
}
function developmentRequests(inputs: Awaited<ReturnType<typeof developmentInputs>>, options: Options, services: Services, observer: GuestObserver, signal: AbortSignal) {
  function post(request: Request, path: string): Promise<Response> | Response {
    if (request.headers.get("origin") !== origin || signal.aborted) return new Response(null, { status: 403 });
    if (path === "/token") return guardedToken(observer, signal, () => services.token(), headers);
    if (path === "/lifecycle") return Response.json(services.lifecycle(), { headers });
    if (path !== `/case/${options.mode}`) return new Response(null, { status: 404 });
    services.select(options.mode);
    observer.begin(options.mode);
    return Response.json({ engine: "browser", asset: inputs.asset, ca: services.ca, password: services.password, endpoint: `http://127.0.0.1:${ports.relayPort}` }, { headers });
  }
  return (request: Request): Promise<Response> | Response => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") return post(request, path);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (path === "/seed") return Response.json(Array.from(inputs.seeds.keys()), { headers });
    const file = path.startsWith("/seed/") ? inputs.seeds.get(path.slice(6)) : inputs.files.get(path);
    return file ? new Response(Bun.file(file), { headers }) : new Response(null, { status: 404 });
  };
}
async function exercise(inputs: Awaited<ReturnType<typeof developmentInputs>>, options: Options, services: Services, owner: TlsCleanup, signal: AbortSignal, secrets: RunSecrets, record: Recorder) {
  const observer = new GuestObserver(secrets);
  const server = await acquireOwned(owner, signal, () => Bun.serve({ hostname: "127.0.0.1", port: ports.pagePort, fetch: developmentRequests(inputs, options, services, observer, signal) }), server => server.stop(true));
  await record({ kind: "page", port: server.port });
  const browser = await acquireOwned(owner, signal, () => chromium.launch({ headless: true }), browser => browser.close());
  const cancelled = () => { void browser.close().catch(() => {}); };
  signal.addEventListener("abort", cancelled, { once: true });
  owner.add(() => { signal.removeEventListener("abort", cancelled); });
  const page = await acquireOwned(owner, signal, () => browser.newPage(), async page => {
    if (!page.isClosed()) await page.evaluate(async () => { await Reflect.get(globalThis, "tlsQualification")?.cancel(); });
    await page.close();
  });
  await page.exposeFunction(GUEST_OBSERVER_BINDING, (row: unknown) => { observer.accept(row); });
  await page.addInitScript(installGuestObserver, GUEST_OBSERVER_BINDING);
  await page.goto(origin);
  await page.waitForFunction(() => !!Reflect.get(globalThis, "tlsQualification"));
  const raw = await deadline(page.evaluate(mode => Reflect.get(globalThis, "tlsQualification").runCase(mode), options.mode), signal, 90_000)
    .catch(async (error: unknown) => { throw await guestCaseFailure(observer, options.mode, error, () => page.evaluate(name => Reflect.get(globalThis, name), `${GUEST_OBSERVER_BINDING}State`), secrets); });
  return { context: assertCaseContext(raw, options.mode, "browser"), audit: await services.audit(options.mode) };
}
async function tlsDevelopment(args: readonly string[]): Promise<void> {
  const options = developmentArguments(args);
  const owner = new TlsCleanup();
  const secrets = new RunSecrets();
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("TLS development interrupted"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
  const timer = setTimeout(stop, 5 * 60_000);
  let failure: unknown, failed = false;
  let result: unknown;
  let lifecycle: (() => unknown) | undefined;
  const resources: object[] = [];
  const record: Recorder = async row => {
    resources.push(row);
    await writeFile(join(options.output, "resources.json"), secrets.redact(JSON.stringify(resources, null, 2)) + "\n", { mode: 0o600 });
  };
  try {
    await mkdir(options.output, { recursive: true });
    const inputs = await developmentInputs(options, owner, abort.signal, record);
    const before = execFileSync(tool("mesh"), ["ssh", "pi", "--", "sh", "-c", 'test ! -e "$HOME/.local/state/machine-fleet/owner-busy" && podman ps -a --format "{{.Names}}" && podman volume ls --format "{{.Name}}" && ss -lnt'], { encoding: "utf8", timeout: 20_000 });
    await record({ kind: "pi-before", observation: before });
    const fixtures = { databaseMachine: "pi", ...ports,
      databaseAddress: execFileSync(tool("mesh"), ["ssh", "pi", "--", "tailscale", "ip", "-4"], { encoding: "utf8", timeout: 15_000 }).trim(),
      relayAddress: execFileSync(tool("tailscale"), ["ip", "-4"], { encoding: "utf8", timeout: 5000 }).trim() };
    const services = await startTlsFixtureServices({ hostSource, tool, recheck: async () => { abort.signal.throwIfAborted(); } }, owner, fixtures, abort.signal, record, secrets);
    lifecycle = services.lifecycle;
    result = await exercise(inputs, options, services, owner, abort.signal, secrets, record);
  } catch (error) { failure = error; failed = true; } finally {
    try { await owner.close(); } catch (error) { failure = failed ? new AggregateError([failure, error], "TLS development and cleanup failed", { cause: failure }) : error; failed = true; }
    clearTimeout(timer);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stop);
  }
  const diagnostic = failed ? JSON.parse(formatTlsFailure(new TlsQualificationFailure("browser", failure, secrets))) : null;
  await writeFile(join(options.output, "result.json"), secrets.redact(JSON.stringify({ development: true, mode: options.mode, status: failed ? "fail" : "pass", applicationTlsAcceptance: false, result, diagnostic, resources, cleanup: lifecycle?.() }, null, 2)) + "\n", { mode: 0o600 });
  await rm(join(options.output, "resources.json"), { force: true });
  if (failed) throw new Error(`TLS development failed; see ${join(options.output, "result.json")}`);
}
if (import.meta.main) await tlsDevelopment(process.argv.slice(2));
