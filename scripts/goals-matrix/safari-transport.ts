import type { Transport } from "./transport";
import { admit, awaitWithin, type Admission } from "./scope";
import { until } from "./playground";
import { armSafariClick, observeSafariClick } from "./safari-click";
import { presentIphonePreview } from "./iphone-browser";
import { SafariOwnershipWitness, ownershipRequest, type SafariOwnershipSink, type SafariOwnershipOperation } from "./safari-ownership";
import { jsonKind, mediaKind, networkKind, newTrace, openFact, webDriverError, type ProtocolLane, type ProtocolObserver, type ProtocolTrace, type SafariProtocolSink } from "./safari-protocol";
export type SafariTransportOptions = {
  ownershipSink?: SafariOwnershipSink;
  protocolSink?: SafariProtocolSink;
  endpoint: string;
  browser: "safari" | "iphone-safari";
  deviceUDID?: string;
  timeoutMs: number;
  cleanupTimeoutMs?: number;
};

export type SafariTransport = Transport;

// The optional decoder runs inside the request, so the request's protocol fact records a
// contract failure (for example HTTP 200 with a null evaluation value) under its own number.
type OwnedRequest = { witness: SafariOwnershipWitness | undefined; operation: SafariOwnershipOperation; admission?: Admission };
type Request = <T>(path: string, body: unknown, method: string | undefined, decode: (value: unknown) => T, owned?: OwnedRequest) => Promise<T>;
const accept = (value: unknown): unknown => value;
type CleanupRequests = { command: Request; session: Request; timeoutMs: number };
type Preview = { kind: "tab"; handle: string } | { kind: "frame"; token: string };

// Serialized with the existing presenter. Reserve ownership before dispatch so a late
// creation still belongs to cleanup after its admission expires.
function presentFrame(input: { url: string; token: string }, present: typeof presentIphonePreview): void {
  if (document.getElementById("__goalsIphonePreview")) throw new Error("Safari preview frame is already occupied");
  present(input.url);
  const frame = document.getElementById("__goalsIphonePreview");
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing Safari preview frame");
  frame.dataset.goalsPresentation = input.token;
}

function ownedFrame(token: string, remove: boolean): HTMLIFrameElement | null {
  const frame = document.getElementById("__goalsIphonePreview");
  if (!frame && remove) return null;
  if (!(frame instanceof HTMLIFrameElement) || frame.dataset.goalsPresentation !== token) throw new Error("Safari preview frame identity changed");
  if (!remove) return frame;
  frame.remove();
  return null;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Safari WebDriver object");
  return value as Record<string, unknown>;
}

function handle(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Missing Safari WebDriver handle");
  return value;
}

function freezeCapabilities(value: unknown): Readonly<Record<string, unknown>> {
  const capabilities = object(value);
  for (const child of Object.values(capabilities)) freezeValue(child);
  return Object.freeze(capabilities);
}

function freezeValue(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeValue(child);
  Object.freeze(value);
}

function requestedCapabilities(options: SafariTransportOptions): Record<string, unknown> {
  if (options.browser === "safari") return { browserName: "safari", platformName: "mac" };
  if (!options.deviceUDID?.trim()) throw new Error("iPhone Safari requires an exact deviceUDID");
  return { browserName: "safari", platformName: "iOS", "safari:useSimulator": true,
    "safari:deviceType": "iPhone", "safari:deviceUDID": options.deviceUDID };
}

function verifyCapabilities(capabilities: Readonly<Record<string, unknown>>, options: SafariTransportOptions): void {
  if (typeof capabilities.browserName !== "string" || capabilities.browserName.toLowerCase() !== "safari") {
    throw new Error(`Expected native Safari capabilities, received ${JSON.stringify(capabilities)}`);
  }
  const platform = typeof capabilities.platformName === "string" ? capabilities.platformName.toLowerCase() : "";
  if (options.browser === "safari") {
    if (!["mac", "macos"].includes(platform) || capabilities["safari:useSimulator"] === true) throw new Error("Expected desktop Safari on macOS");
    return;
  }
  if (platform !== "ios" || capabilities["safari:useSimulator"] !== true || capabilities["safari:deviceType"] !== "iPhone"
    || capabilities["safari:deviceUDID"] !== options.deviceUDID) {
    throw new Error(`Expected iPhone simulator Safari for device ${options.deviceUDID}, received ${JSON.stringify(capabilities)}`);
  }
}

function createRequest(endpoint: string, timeoutMs: number, signal?: AbortSignal, observer?: ProtocolObserver): Request {
  return async <T>(path: string, body: unknown, requested: string | undefined, decode: (value: unknown) => T, owned?: OwnedRequest): Promise<T> => {
    const method = requested ?? (body === undefined ? "GET" : "POST");
    const trace = newTrace();
    const emit = observer ? openFact(observer, path, method) : undefined;
    try {
      const send = () => {
        if (owned?.admission) admit(owned.admission);
        return exchange(endpoint + path, { method, timeoutMs, signal, body, path }, trace);
      };
      const value = owned ? await ownershipRequest(owned.witness, owned.operation, send, owned.admission) : await send();
      trace.stage = "contract";
      const decoded = decode(value);
      trace.stage = "valid";
      return decoded;
    } catch (error) {
      if (trace.stage === "fetch") trace.network = networkKind(error);
      throw error;
    } finally { emit?.(trace); }
  };
}

type Exchange = { method: string; timeoutMs: number; signal?: AbortSignal; body: unknown; path: string };
async function exchange(url: string, { method, timeoutMs, signal, body, path }: Exchange, trace: ProtocolTrace): Promise<unknown> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  trace.status = response.status;
  trace.media = mediaKind(response.headers.get("content-type"));
  trace.stage = "decode-json";
  const decoded: unknown = await response.json();
  trace.envelope = jsonKind(decoded);
  trace.stage = "envelope";
  const envelope = object(decoded);
  if (!("value" in envelope)) throw new Error(`Safari WebDriver ${method} ${path} returned no value`);
  const value = envelope.value;
  trace.value = jsonKind(value);
  trace.error = webDriverError(value);
  trace.stage = "status";
  if (!response.ok) throw new Error(`Safari WebDriver ${method} ${path} (${response.status}): ${JSON.stringify(value)}`);
  trace.stage = "webdriver";
  if (value !== null && typeof value === "object" && "error" in value) throw new Error(`Safari WebDriver ${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}

type EvaluationReply = { ok: true; value: unknown } | { ok: false; message: unknown; stack: unknown };
// The evaluation contract. A guest error is a valid reply; a non-object or a success without JSON is not.
function evaluationReply(value: unknown): EvaluationReply {
  const result = object(value);
  if (result.ok !== true) return { ok: false, message: result.message, stack: result.stack };
  if (typeof result.json !== "string") throw new Error("Safari evaluation returned no JSON value");
  return { ok: true, value: JSON.parse(result.json) };
}

function elementReply(value: unknown): Record<string, unknown> {
  const element = object(value);
  handle(element["element-6066-11e4-a52e-4f735466cecf"]);
  return element;
}

function tabReply(value: unknown): Record<string, unknown> {
  const tab = object(value);
  handle(tab.handle);
  return tab;
}

async function cleanupAfterFailure(error: unknown, cleanup: () => Promise<void>): Promise<never> {
  try { await cleanup(); }
  catch (cleanupError) { throw new AggregateError([error, cleanupError], `Safari operation failed: ${String(error)}; cleanup failed: ${String(cleanupError)}`); }
  throw error;
}

const evaluateScript = `
const done = arguments[arguments.length - 1];
const expression = arguments[0];
Promise.resolve().then(() => (0, eval)(expression)).then(value => {
  done({ ok: true, json: JSON.stringify(value === undefined ? null : value) });
}).catch(error => done({ ok: false, message: String(error), stack: error && error.stack ? String(error.stack) : "" }));
`;

function transport(request: Request, sessionPath: string, host: string, capabilities: SafariTransport["capabilities"], lifetime: AbortController, cleanup: CleanupRequests, browser: SafariTransportOptions["browser"], witness?: SafariOwnershipWitness): SafariTransport {
  let preview: Preview | undefined;
  let tail = Promise.resolve();
  let closing: Promise<void> | undefined;
  let operationRequest = request;
  const decodedCommand = <T>(admission: Admission | undefined, path: string, body: unknown, method: string | undefined, decode: (value: unknown) => T): Promise<T> => {
    if (admission) admit(admission);
    return operationRequest(sessionPath + path, body, method, decode);
  };
  const command = (admission: Admission | undefined, path: string, body?: unknown, method?: string): Promise<unknown> => decodedCommand(admission, path, body, method, accept);
  const ownedCommand = (operation: SafariOwnershipOperation, admission: Admission | undefined, path: string, body?: unknown, method?: string, decode: (value: unknown) => unknown = accept) => {
    if (admission) admit(admission);
    return operationRequest(sessionPath + path, body, method, decode, { witness, operation, admission });
  };
  const select = async (selected: string, admission?: Admission): Promise<void> => { await command(admission, "/window", { handle: selected }); };
  const navigate = async (url: string, admission: Admission): Promise<void> => { await command(admission, "/url", { url }); };

  async function hostContext(admission?: Admission): Promise<void> {
    await select(host, admission);
    if (browser === "safari") await command(admission, "/frame", { id: null });
  }

  async function frameElement(token: string, remove: boolean, admission?: Admission): Promise<unknown> {
    return ownedCommand({ kind: remove ? "frame-remove" : "frame-reference", token }, admission, "/execute/sync", { script: `return (${ownedFrame.toString()})(arguments[0], arguments[1]);`, args: [token, remove] }, undefined, remove ? accept : elementReply);
  }

  async function previewContext(admission: Admission): Promise<void> {
    if (!preview) throw new Error("Safari transport has no preview");
    if (preview.kind === "tab") return select(preview.handle, admission);
    await hostContext(admission);
    const element = object(await frameElement(preview.token, false, admission));
    const id = handle(element["element-6066-11e4-a52e-4f735466cecf"]);
    await ownedCommand({ kind: "frame-select", token: preview.token, element: id }, admission, "/frame", { id: element });
  }

  function serial<T>(admission: Admission, action: () => Promise<T>): Promise<T> {
    admit(admission);
    if (closing) return Promise.reject(new Error("Safari transport is closed"));
    const result = tail.then(() => { lifetime.signal.throwIfAborted(); admit(admission); return action(); });
    // Recover only the queue tail. The caller still receives the original rejection.
    tail = result.then(() => undefined, () => undefined);
    return awaitWithin(result, admission);
  }

  async function closePreview(admission?: Admission): Promise<void> {
    if (preview === undefined) return;
    try {
      if (preview.kind === "tab") await closeTab(preview.handle, admission);
      else { await hostContext(admission); await frameElement(preview.token, true, admission); }
      preview = undefined;
    } catch (error) {
      if (admission && (admission.signal.aborted || Date.now() >= admission.deadline)) throw error;
      return cleanupAfterFailure(error, () => hostContext());
    }
    await hostContext(admission);
  }

  async function closeTab(selected: string, admission?: Admission): Promise<void> {
    await select(selected, admission);
    await ownedCommand({ kind: "preview-tab-close", handle: selected }, admission, "/window", undefined, "DELETE");
  }

  async function openPreview(url: string, admission: Admission): Promise<void> {
    try {
      if (browser === "safari") return await openFrame(url, admission);
      const selected = await ownedPreview(admission);
      await select(selected, admission);
      await navigate(url, admission);
    } catch (error) {
      if (admission.signal.aborted || Date.now() >= admission.deadline) throw error;
      return cleanupAfterFailure(error, () => closePreview());
    }
  }

  async function openFrame(url: string, admission: Admission): Promise<void> {
    await closePreview(admission);
    await hostContext(admission);
    const token = crypto.randomUUID();
    preview = { kind: "frame", token };
    await ownedCommand({ kind: "frame-present", token }, admission, "/execute/sync", {
      script: `(${presentFrame.toString()})(arguments[0], ${presentIphonePreview.toString()}); return null;`, args: [{ url, token }],
    });
    await previewContext(admission);
  }

  async function ownedPreview(admission: Admission): Promise<string> {
    if (preview?.kind === "tab") return preview.handle;
    const created = handle(object(await ownedCommand({ kind: "preview-tab-create" }, admission, "/window/new", { type: "tab" }, undefined, tabReply)).handle);
    if (created === host) throw new Error("Safari returned the host handle for a new preview");
    preview = { kind: "tab", handle: created };
    return created;
  }

  async function evaluate<T>(expression: string, admission: Admission): Promise<T> {
    const result = await decodedCommand(admission, "/execute/async", { script: evaluateScript, args: [expression] }, undefined, evaluationReply);
    if (!result.ok) throw new Error(`Safari evaluation failed: ${String(result.message)}\n${String(result.stack ?? "")}`);
    return result.value as T;
  }

  async function nativeClick(button: string, clicked: string, admission: Admission): Promise<unknown> {
    const input = { button, clicked, token: crypto.randomUUID() };
    const arm = `(${armSafariClick.toString()})(${JSON.stringify(input)})`;
    const before = await until(() => evaluate<ReturnType<typeof armSafariClick>>(arm, admission), value => value.ready, admit(admission));
    if (!before.ready) throw new Error("Safari counter is not ready");
    const element = await decodedCommand(admission, "/element", { using: "css selector", value: button }, undefined, elementReply);
    const id = handle(element["element-6066-11e4-a52e-4f735466cecf"]);
    await command(admission, `/element/${encodeURIComponent(id)}/click`, {});
    const observation = `(${observeSafariClick.toString()})(${JSON.stringify(input)})`;
    const expected = before.before.replace(/\b0\b/, "1");
    const after = await until(() => evaluate<ReturnType<typeof observeSafariClick>>(observation, admission), value => value.trusted && value.after === expected, admit(admission));
    return { before: before.before, after: after.after, trusted: true, inputMethod: "Safari WebDriver element click" };
  }

  return Object.freeze({ capabilities,
    ...(browser === "safari" ? { nativeClick: (button: string, clicked: string, admission: Admission) => serial(admission, () => nativeClick(button, clicked, admission)) } : {}),
    beginCleanup: (admission: Admission) => serial(admission, async () => {
      operationRequest = cleanup.command;
      await command(admission, "/timeouts", { script: cleanup.timeoutMs, pageLoad: cleanup.timeoutMs, implicit: 0 });
    }),
    navigate: (url: string, admission: Admission) => serial(admission, () => navigate(url, admission)),
    evaluate: <T>(expression: string, admission: Admission) => serial(admission, () => evaluate<T>(expression, admission)),
    openPreview: (url: string, admission: Admission) => serial(admission, () => openPreview(url, admission)),
    useHost: (admission: Admission) => serial(admission, () => hostContext(admission)),
    usePreview: (admission: Admission) => serial(admission, () => previewContext(admission)),
    closePreview: (admission: Admission) => serial(admission, () => closePreview(admission)),
    close(interruptPending = false) {
      if (interruptPending) lifetime.abort(new Error("Safari session cleanup interrupted pending commands"));
      return closing ??= tail.then(() => finishSession(witness, cleanup, sessionPath));
    },
  });
}

async function finishSession(witness: SafariOwnershipWitness | undefined, cleanup: CleanupRequests, sessionPath: string): Promise<void> {
  const remove = async () => { await ownershipRequest(witness, { kind: "session-delete" }, () => cleanup.session(sessionPath, undefined, "DELETE", accept)); };
  if (witness) await witness.finish(remove);
  else await remove();
}

export async function createSafariTransport(options: SafariTransportOptions): Promise<SafariTransport> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw new Error("Safari timeoutMs must be a positive timer-sized integer");
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? Math.min(options.timeoutMs, 10_000);
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 2_147_483_647) throw new Error("Safari cleanupTimeoutMs must be a positive timer-sized integer");
  const endpoint = new URL(options.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.search || endpoint.hash) throw new Error("Expected an HTTP SafariDriver endpoint without a query or fragment");
  const requested = requestedCapabilities(options);
  const lifetime = new AbortController();
  const address = endpoint.href.replace(/\/$/, "");
  const counter = { value: 0 };
  const observe = (lane: ProtocolLane): ProtocolObserver | undefined => options.protocolSink ? { sink: options.protocolSink, lane, counter } : undefined;
  const request = createRequest(address, options.timeoutMs, lifetime.signal, observe("command"));
  const cleanup = { command: createRequest(address, cleanupTimeoutMs, lifetime.signal, observe("cleanup-command")), session: createRequest(address, cleanupTimeoutMs, undefined, observe("session")), timeoutMs: cleanupTimeoutMs };
  const witness = options.ownershipSink ? new SafariOwnershipWitness(options.ownershipSink) : undefined;
  let sessionPath: string | undefined;
  let opened: Record<string, unknown>;
  const sessionReply = (value: unknown) => {
    const result = object(value);
    sessionPath = `/session/${encodeURIComponent(handle(result.sessionId))}`;
    const capabilities = freezeCapabilities(result.capabilities);
    verifyCapabilities(capabilities, options);
    return result;
  };
  try {
    opened = await request("/session", { capabilities: { alwaysMatch: requested } }, undefined, sessionReply, { witness, operation: { kind: "session-create" } });
  } catch (error) {
    const path = sessionPath;
    return cleanupAfterFailure(error, () => path ? finishSession(witness, cleanup, path) : witness ? witness.finish(async () => {}) : Promise.resolve());
  }
  if (!sessionPath) throw new Error("Missing Safari session path");
  const path = sessionPath;
  try {
    const capabilities = freezeCapabilities(opened.capabilities);
    await request(`${path}/timeouts`, { script: options.timeoutMs, pageLoad: options.timeoutMs, implicit: 0 }, undefined, accept);
    const host = await request(`${path}/window`, undefined, undefined, handle, { witness, operation: { kind: "host-handle" } });
    return transport(request, path, host, capabilities, lifetime, cleanup, options.browser, witness);
  } catch (error) { return cleanupAfterFailure(error, () => finishSession(witness, cleanup, path)); }
}
