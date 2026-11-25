// Private scalar transport. Original request/reply messages never pass through it.
const generation = crypto.randomUUID();
const realm = typeof document === "undefined" ? "worker" : "page";
const pending: object[] = [];
const output = console.debug.bind(console);
const transport = "bunwasm-storage-routing";
let sequence = 0;
let dropped = 0;
let sending = false;
const enabled = realm === "worker" || Reflect.get(globalThis, "__bunwasmStorageFirstEvent") === true;

function scalar(value: unknown): string | number | boolean | null {
  if (typeof value === "string") return value.slice(0, 2048);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return typeof value === "boolean" ? value : null;
}
function record(value: Record<string, unknown>): void {
  if (!enabled || !selected(value)) return;
  const fields = Object.fromEntries(Object.entries(value).map(([key, value]) => [key, scalar(value)]));
  const row = { ...fields, generation, realm, scope: realm === "worker" ? Reflect.get(globalThis, "registration")?.scope ?? null : null,
    realmURL: location.href, sequence: ++sequence, dropped };
  if (realm === "page") { output("[storage-routing] " + JSON.stringify(row)); return; }
  if (pending.length === 256) { dropped++; return; }
  pending.push(row);
  void drain();
}
function selected(value: Record<string, unknown>): boolean {
  if (typeof value.kind === "string" && ["evaluated-generation", "runtime-router", "register", "unregister", "helper-projection"].includes(value.kind)) return true;
  const target = value.target ?? value.url;
  if (typeof target !== "string") return false;
  try {
    const path = new URL(target, "https://diagnostic.invalid").pathname.replace(/^.*\/__preview\/(?:r\/[^/]+\/)?\d+/, "");
    return ["/", "/@vite/client", "/src/main.ts"].includes(path);
  } catch { return false; }
}
async function drain(): Promise<void> {
  if (sending) return;
  sending = true;
  try { await deliver(); }
  finally { sending = false; }
}
async function deliver(): Promise<void> {
  const clients: Clients = Reflect.get(globalThis, "clients");
  while (pending.length) {
    const rows = pending.splice(0, 16);
    try {
      const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!windows.length) { dropped += rows.length; continue; }
      const delivered = windows.map(client => send(client, rows));
      if (!delivered.some(Boolean)) dropped += rows.length;
    } catch { dropped += rows.length; }
  }
}
function send(client: WindowClient, rows: object[]): boolean {
  try { client.postMessage({ diagnostic: transport, rows, dropped }); return true; }
  catch { return false; }
}
function receive(event: MessageEvent): void {
  if (event.data?.diagnostic !== transport) return;
  const { rows, dropped } = event.data;
  if (!Array.isArray(rows) || rows.length > 16 || typeof dropped !== "number") {
    output("[storage-routing-error] Invalid scalar transport batch"); return;
  }
  for (const row of rows) output("[storage-routing] " + JSON.stringify({ ...row, dropped }));
}
if (enabled && realm === "page") navigator.serviceWorker?.addEventListener("message", receive);
Reflect.set(globalThis, "__routingTrace", record);
record({ kind: "evaluated-generation" });
