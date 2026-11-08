export type SafariTransportOptions = {
  endpoint: string;
  browser: "safari" | "iphone-safari";
  deviceUDID?: string;
  timeoutMs: number;
};

export type SafariTransport = {
  readonly capabilities: Readonly<Record<string, unknown>>;
  navigate(url: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  openPreview(url: string): Promise<void>;
  useHost(): Promise<void>;
  usePreview(): Promise<void>;
  closePreview(): Promise<void>;
  close(): Promise<void>;
};

type Request = (path: string, body?: unknown, method?: string) => Promise<unknown>;

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

function createRequest(endpoint: string, timeoutMs: number): Request {
  return async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(endpoint + path, { method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const envelope = object(await response.json());
    if (!("value" in envelope)) throw new Error(`Safari WebDriver ${method} ${path} returned no value`);
    const value = envelope.value;
    if (!response.ok) throw new Error(`Safari WebDriver ${method} ${path} (${response.status}): ${JSON.stringify(value)}`);
    if (value !== null && typeof value === "object" && "error" in value) throw new Error(`Safari WebDriver ${method} ${path}: ${JSON.stringify(value)}`);
    return value;
  };
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

function transport(request: Request, sessionPath: string, host: string, capabilities: SafariTransport["capabilities"]): SafariTransport {
  let preview: string | undefined;
  let tail = Promise.resolve();
  let closing: Promise<void> | undefined;
  const command: Request = (path, body, method) => request(sessionPath + path, body, method);
  const select = async (selected: string): Promise<void> => { await command("/window", { handle: selected }); };
  const navigate = async (url: string): Promise<void> => { await command("/url", { url }); };

  function serial<T>(action: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error("Safari transport is closed"));
    const result = tail.then(action);
    // Recover only the queue tail. The caller still receives the original rejection.
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function closePreview(): Promise<void> {
    if (preview === undefined) return;
    try {
      await select(preview);
      await command("/window", undefined, "DELETE");
      preview = undefined;
    } catch (error) { return cleanupAfterFailure(error, () => select(host)); }
    await select(host);
  }

  async function openPreview(url: string): Promise<void> {
    try {
      if (preview === undefined) {
        const created = handle(object(await command("/window/new", { type: "tab" })).handle);
        if (created === host) throw new Error("Safari returned the host handle for a new preview");
        preview = created;
      }
      await select(preview);
      await navigate(url);
    } catch (error) { return cleanupAfterFailure(error, closePreview); }
  }

  async function evaluate<T>(expression: string): Promise<T> {
    const result = object(await command("/execute/async", { script: evaluateScript, args: [expression] }));
    if (result.ok !== true) throw new Error(`Safari evaluation failed: ${String(result.message)}\n${String(result.stack ?? "")}`);
    if (typeof result.json !== "string") throw new Error("Safari evaluation returned no JSON value");
    return JSON.parse(result.json);
  }

  return Object.freeze({ capabilities,
    navigate: (url: string) => serial(() => navigate(url)),
    evaluate: <T>(expression: string) => serial(() => evaluate<T>(expression)),
    openPreview: (url: string) => serial(() => openPreview(url)),
    useHost: () => serial(() => select(host)),
    usePreview: () => serial(async () => {
      if (preview === undefined) throw new Error("Safari transport has no preview");
      await select(preview);
    }),
    closePreview: () => serial(closePreview),
    close() { return closing ??= tail.then(async () => { await request(sessionPath, undefined, "DELETE"); }); },
  });
}

export async function createSafariTransport(options: SafariTransportOptions): Promise<SafariTransport> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw new Error("Safari timeoutMs must be a positive timer-sized integer");
  const endpoint = new URL(options.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.search || endpoint.hash) throw new Error("Expected an HTTP SafariDriver endpoint without a query or fragment");
  const requested = requestedCapabilities(options);
  const request = createRequest(endpoint.href.replace(/\/$/, ""), options.timeoutMs);
  const opened = object(await request("/session", { capabilities: { alwaysMatch: requested } }));
  const sessionPath = `/session/${encodeURIComponent(handle(opened.sessionId))}`;
  try {
    const capabilities = freezeCapabilities(opened.capabilities);
    verifyCapabilities(capabilities, options);
    await request(`${sessionPath}/timeouts`, { script: options.timeoutMs, pageLoad: options.timeoutMs, implicit: 0 });
    const host = handle(await request(`${sessionPath}/window`));
    return transport(request, sessionPath, host, capabilities);
  } catch (error) { return cleanupAfterFailure(error, async () => { await request(sessionPath, undefined, "DELETE"); }); }
}
