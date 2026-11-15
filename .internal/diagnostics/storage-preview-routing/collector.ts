// An append-only diagnostic journal. Original protocol messages never pass through this transport.
const state = { generation: crypto.randomUUID(), rows: [] as object[], pending: [] as object[], failures: [] as string[], sequence: 0 };
const realm = typeof document === "undefined" ? "worker" : "page";
const scope = realm === "worker" ? Reflect.get(globalThis, "registration")?.scope : null;
declare const __STORAGE_ROUTING_BUILD__: string;
const build = __STORAGE_ROUTING_BUILD__;
const identity = () => ({ generation: state.generation, realm, scope, build, url: location.href,
  timeOrigin: performance.timeOrigin, mainDocument: realm === "page" ? window === window.top : null });
let timer: ReturnType<typeof setTimeout> | undefined;
let sending = Promise.resolve();
function post(batch: object[]) {
  return fetch(new URL("/__storage-routing-evidence", location.origin), { method: "POST", body: JSON.stringify(batch), headers: { "content-type": "application/json" } })
    .then(response => { if (!response.ok) throw new Error(`journal HTTP ${response.status}`); })
    .catch(error => { state.failures.push(String(error)); });
}
function drain() {
  clearTimeout(timer); timer = undefined;
  while (state.pending.length) {
    const batch = state.pending.splice(0, 32);
    sending = sending.then(() => post(batch));
  }
  return sending;
}
function trace(value: object) {
  const row = { ...identity(), journalSequence: ++state.sequence, value };
  state.rows.push(row);
  const binding = Reflect.get(globalThis, "__storageRoutingRecord");
  if (realm === "page" && typeof binding === "function") {
    sending = Promise.all([sending, binding(JSON.stringify(row))]).then(() => {}).catch(error => { state.failures.push(String(error)); });
    return;
  }
  state.pending.push(row);
  timer ??= setTimeout(() => void drain(), 25);
}
Reflect.set(globalThis, "__routingTrace", trace);
Reflect.set(globalThis, "__routingJournal", { snapshot: () => ({ ...identity(), rows: state.rows, failures: state.failures }), drain });
trace({ kind: "evaluated-generation" });
if (realm === "worker") addEventListener("message", event => {
  const message = event;
  if (message.data?.type !== "storage-routing-diagnostic-snapshot" || !message.ports[0]) return;
  message.ports[0].postMessage({ ...identity(), rows: state.rows, failures: state.failures });
  message.ports[0].close();
});
if (realm === "worker") addEventListener("activate", () => trace({ kind: "activated-generation" }));
if (realm === "page") addEventListener("pagehide", () => void drain());
