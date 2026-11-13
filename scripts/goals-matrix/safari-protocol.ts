// Metadata-only observation of Safari WebDriver requests for the opt-in causal capture.
// Facts carry finite command names, status and JSON shapes. They never carry bodies,
// scripts, URLs, handles or error messages.

export type Clock = Readonly<{ utc: string; monotonicMs: number }>;
export type JsonKind = "missing" | "null" | "object" | "array" | "string" | "number" | "boolean";
export type ProtocolLane = "command" | "cleanup-command" | "session";
type ProtocolCommand ="session-create" | "session-delete" | "timeouts" | "window-handle" | "window-switch" | "window-close"
  | "window-new" | "navigate" | "frame" | "execute-sync" | "execute-async" | "element-find" | "element-click" | "other";
type ProtocolResult =
  | { kind: "valid" }
  | { kind: "network-failure"; error: "abort" | "timeout" | "network" }
  | { kind: "json-decode-failure" | "envelope-invalid" | "contract-failure" }
  | { kind: "http-error" | "webdriver-error"; error: WebDriverError | null };
export type SafariProtocolFact = Readonly<{
  request: number; lane: ProtocolLane; method: "GET" | "POST" | "DELETE" | "other"; command: ProtocolCommand;
  dispatched: Clock; settled: Clock; status: number | null; media: "json" | "other" | "none" | null;
  envelope: JsonKind | null; value: JsonKind | null; result: ProtocolResult;
}>;
export type SafariProtocolSink = (fact: SafariProtocolFact) => void;

const webDriverErrors = ["detached shadow root", "element click intercepted", "element not interactable", "insecure certificate",
  "invalid argument", "invalid cookie domain", "invalid element state", "invalid selector", "invalid session id", "javascript error",
  "move target out of bounds", "no such alert", "no such cookie", "no such element", "no such frame", "no such shadow root",
  "no such window", "script timeout", "session not created", "stale element reference", "timeout", "unable to capture screen",
  "unable to set cookie", "unexpected alert open", "unknown command", "unknown error", "unknown method", "unsupported operation"] as const;
export type WebDriverError = typeof webDriverErrors[number] | "other";

/** Per-request progress, updated by the request function before each check that can throw. */
export type ProtocolTrace = {
  stage: "fetch" | "decode-json" | "envelope" | "status" | "webdriver" | "contract" | "valid";
  status: number | null; media: SafariProtocolFact["media"]; envelope: JsonKind | null; value: JsonKind | null;
  error: WebDriverError | null; network?: "abort" | "timeout" | "network";
};
export type ProtocolObserver = Readonly<{ sink: SafariProtocolSink; lane: ProtocolLane; counter: { value: number } }>;

export function clock(): Clock {
  return { utc: new Date().toISOString(), monotonicMs: Math.round(performance.now() * 1000) / 1000 };
}

export function jsonKind(value: unknown): JsonKind {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const kind = typeof value;
  if (kind === "object" || kind === "string" || kind === "number" || kind === "boolean") return kind;
  return "missing";
}

export function mediaKind(contentType: string | null): SafariProtocolFact["media"] {
  if (contentType === null) return "none";
  return /^application\/json\b/i.test(contentType.trim()) ? "json" : "other";
}

export function webDriverError(value: unknown): WebDriverError | null {
  if (value === null || typeof value !== "object" || !("error" in value)) return null;
  const code: unknown = value.error;
  return webDriverErrors.find(known => known === code) ?? "other";
}

export function networkKind(error: unknown): "abort" | "timeout" | "network" {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "abort";
  return "network";
}

const sessionRoutes: Record<string, ProtocolCommand> = { "/timeouts": "timeouts", "/window/new": "window-new", "/url": "navigate", "/frame": "frame",
  "/execute/sync": "execute-sync", "/execute/async": "execute-async", "/element": "element-find" };
const windowCommands: Record<string, ProtocolCommand> = { GET: "window-handle", POST: "window-switch", DELETE: "window-close" };

function protocolCommand(path: string, method: string): ProtocolCommand {
  if (path === "/session") return method === "POST" ? "session-create" : "other";
  const rest = /^\/session\/[^/]+(\/.*)?$/.exec(path)?.[1];
  if (rest === undefined) return /^\/session\/[^/]+$/.test(path) && method === "DELETE" ? "session-delete" : "other";
  if (rest === "/window") return windowCommands[method] ?? "other";
  if (/^\/element\/[^/]+\/click$/.test(rest)) return "element-click";
  return sessionRoutes[rest] ?? "other";
}

function result(trace: ProtocolTrace): ProtocolResult {
  if (trace.stage === "valid") return { kind: "valid" };
  if (trace.stage === "fetch") return { kind: "network-failure", error: trace.network ?? "network" };
  if (trace.stage === "decode-json") return { kind: "json-decode-failure" };
  if (trace.stage === "envelope") return { kind: "envelope-invalid" };
  if (trace.stage === "contract") return { kind: "contract-failure" };
  return { kind: trace.stage === "status" ? "http-error" : "webdriver-error", error: trace.error };
}

export function newTrace(): ProtocolTrace {
  return { stage: "fetch", status: null, media: null, envelope: null, value: null, error: null };
}

/** Starts one request record. The returned function emits it once; sink failures never reach the request. */
export function openFact(observer: ProtocolObserver, path: string, method: string): (trace: ProtocolTrace) => void {
  const request = ++observer.counter.value;
  const dispatched = clock();
  const command = protocolCommand(path, method);
  const verb = method === "GET" || method === "POST" || method === "DELETE" ? method : "other";
  return trace => {
    const fact: SafariProtocolFact = { request, lane: observer.lane, method: verb, command, dispatched, settled: clock(),
      status: trace.status, media: trace.media, envelope: trace.envelope, value: trace.value, result: result(trace) };
    try { observer.sink(fact); }
    catch { /* The capture records its own writer failures; the request keeps its original outcome. */ }
  };
}
