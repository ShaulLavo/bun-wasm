import { createRuntime } from "waffle";
import { loadBunWasm, parseBunWasmAsset } from "../../src/assets.ts";
import { startRun, type Run } from "../src/runner.ts";
import { assertPgResult, isCase, isEngine, type QualificationCase } from "../../scripts/tls-qualification-context.ts";
import { TlsCleanup, acquireOwned, closeObservedCase, deadline, trackCaseRuntime } from "../../scripts/tls-qualification-lifecycle.ts";
import type { ProcessRuntime } from "../../src/process-runtime.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid TLS page configuration");
  return value as Record<string, unknown>;
}
async function json(path: string, method = "GET"): Promise<unknown> {
  const response = await fetch(path, { method, cache: "no-store" });
  if (!response.ok) throw new Error("TLS page control request failed");
  return response.json();
}
async function bytes(path: string): Promise<Uint8Array> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error("TLS page seed missing");
  return new Uint8Array(await response.arrayBuffer());
}
async function seed(runtime: ProcessRuntime, ca: string, mode: QualificationCase): Promise<void> {
  const paths = await json("/seed");
  if (!Array.isArray(paths)) throw new Error("Invalid TLS pg seed registry");
  await runtime.filesystem.mkdirp("/home/user/tls");
  for (const path of paths) {
    if (typeof path !== "string" || !path.startsWith("node_modules/") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe pg seed path");
    const target = `/home/user/${path}`;
    await runtime.filesystem.mkdirp(target.slice(0, target.lastIndexOf("/")));
    await runtime.filesystem.writeFile(target, await bytes(`/seed/${path}`));
  }
  await runtime.filesystem.writeFile("/home/user/query.ts", await bytes("/pg-client.ts"));
  if (mode !== "no-extra-ca") await runtime.filesystem.writeFile("/home/user/tls/ca.pem", new TextEncoder().encode(ca));
  await runtime.filesystem.flush();
}
async function relayOwner(runtime: ProcessRuntime, endpoint: string, observed: string[]) {
  // Resolved to the explicitly reviewed host checkout by the qualification build.
  const entry = "tls-reviewed-relay";
  const api = record(await import(entry));
  if (typeof api.runtimeRelay !== "function") throw new Error("Reviewed C1 runtimeRelay is unavailable");
  const value = record(await api.runtimeRelay(runtime, { endpoint, carriers: ["websocket"],
    getToken: async () => {
      const response = await fetch("/token", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error("TLS relay token request failed");
      return response.text();
    }, onCarrier: (carrier: string) => observed.push(carrier), connectTimeoutMs: 15_000,
  }));
  if (typeof value.connect !== "function" || typeof value.close !== "function") throw new Error("Invalid C1 runtime relay owner");
  return { connect: value.connect, close: value.close.bind(value) };
}
let active: Run | undefined;
let runtimeOwner: ProcessRuntime | undefined;
const shutdown = new AbortController();
async function runCase(mode: unknown) {
  shutdown.signal.throwIfAborted();
  if (!isCase(mode) || !crossOriginIsolated || location.hostname !== "127.0.0.1") throw new Error("TLS requires an isolated same-machine loopback page");
  const config = record(await json(`/case/${mode}`, "POST"));
  if (!isEngine(config.engine) || typeof config.endpoint !== "string" || new URL(config.endpoint).hostname !== "127.0.0.1"
    || typeof config.ca !== "string" || typeof config.password !== "string" || !config.password) throw new Error("Invalid private TLS configuration");
  const { engine, endpoint, ca, password } = config;
  const asset = parseBunWasmAsset(config.asset);
  const module = await deadline(loadBunWasm({ asset }), shutdown.signal, 90_000);
  const owner = new TlsCleanup();
  let tracked: ReturnType<typeof trackCaseRuntime> | undefined;
  let lifecycle;
  let parsed: ReturnType<typeof assertPgResult> | undefined;
  const observed: string[] = [];
  let relay: Awaited<ReturnType<typeof relayOwner>> | undefined;
  let output = "";
  try {
    const actual = await acquireOwned(owner, shutdown.signal, () => createRuntime({ filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) } }), runtime => runtime.dispose());
    tracked = trackCaseRuntime(actual);
    const runtime = tracked.runtime;
    runtimeOwner = runtime;
    await deadline(seed(runtime, ca, mode), shutdown.signal, 30_000);
    relay = await acquireOwned(owner, shutdown.signal, () => relayOwner(runtime, endpoint, observed), async relay => { await relay.close(); });
    const network = { fetch: undefined, connect: relay.connect };
    const extra: Record<string, string> = mode === "no-extra-ca" ? {} : { NODE_EXTRA_CA_CERTS: "/home/user/tls/ca.pem" };
    active = await acquireOwned(owner, shutdown.signal, () => { active = startRun({ runtime, module, engine, moduleScope: false, args: ["/home/user/query.ts"],
      env: { PWD: "/home/user", HOME: "/home/user", PATH: "/bin:/usr/bin", TLS_PG_CASE: mode,
        PGHOST: mode === "hostname" ? "wrong.tls.test" : mode === "rejection" ? "reject.tls.test" : "pg.tls.test", PGPORT: "5432", PGPASSWORD: password, ...extra }, network },
    { stdout: data => { if (output.length > 8192) throw new Error("TLS guest output exceeded limit"); output += new TextDecoder().decode(data); }, stderr() {} }); return active; }, async run => { run.kill(9); await run.done; });
    const result = await deadline(active.done, shutdown.signal, 90_000);
    if (result.code !== 0 || result.error) throw new Error("Guest TLS pg case failed");
    if (observed.length !== 1 || observed[0] !== "websocket") throw new Error("TLS must use the forced WebSocket carrier on one TCP connection");
    parsed = assertPgResult(JSON.parse(output.trim()), mode);
  } finally {
    lifecycle = await closeObservedCase({ dispose: () => owner.close(), close: async () => { await relay?.close(); }, observe: async () => {
      if (!tracked) throw new Error("Runtime lifecycle observer was not acquired");
      const relayState = record(await json("/lifecycle", "POST"));
      return { runtimeDisposed: tracked.runtime.disposed, liveConsumers: tracked.liveConsumers(), relayActive: relayState.relayActive };
    } });
    active = undefined;
    runtimeOwner = undefined;
  }
  if (!parsed) throw new Error("Missing guest result");
  return { engine, carrier: observed[0], connections: observed.length, result: parsed, lifecycle };
}
Reflect.set(globalThis, "tlsQualification", {
  runCase,
  async cancel() { shutdown.abort(new Error("TLS page cancelled")); active?.kill(9); await runtimeOwner?.dispose(); },
});
