type BrowserTask = { id: number; source: string; deadline: number };
declare global { var __goalsIphoneDocument: { nonce: string; url: string; timeOrigin: number } | undefined; }

// Serialized into the test page, independently of the application bundles.
export function installIphoneObserver(endpoint: string, nonce: string): void {
  const key = { nonce, url: location.href, timeOrigin: performance.timeOrigin };
  globalThis.__goalsIphoneDocument = key;
  let stopped = false;
  let pending = false;
  const timer = setInterval(() => { void poll(); }, 50);
  addEventListener("pagehide", () => { stopped = true; clearInterval(timer); }, { once: true });
  async function send(route: string, value: object): Promise<unknown> {
    const response = await fetch(endpoint + route, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...key, ...value }), signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`iPhone observer HTTP ${response.status}`);
    return response.json();
  }
  async function execute(task: BrowserTask): Promise<void> {
    try {
      if (Date.now() >= task.deadline) throw new Error("Expired iPhone observer command");
      // eslint-disable-next-line no-eval -- This isolated test observer executes the runner's existing page expressions.
      const value: unknown = await (0, eval)(task.source);
      await send("reply", { id: task.id, ok: true, value: value ?? null });
    } catch (error) { await send("reply", { id: task.id, ok: false, error: String(error) }); }
  }
  async function poll(): Promise<void> {
    if (stopped || pending) return;
    pending = true;
    try {
      const value = await send("poll", { visible: document.visibilityState === "visible", userAgent: navigator.userAgent });
      if (value !== null) await execute(parse(value));
    } catch { stopped = true; clearInterval(timer); }
    finally { pending = false; }
  }
  function parse(value: unknown): BrowserTask {
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "number"
      || !("source" in value) || typeof value.source !== "string" || !("deadline" in value) || typeof value.deadline !== "number") throw new Error("Malformed iPhone observer command");
    return { id: value.id, source: value.source, deadline: value.deadline };
  }
  void poll();
}

export function presentIphonePreview(url: string | null): void {
  document.getElementById("__goalsIphonePreview")?.remove();
  if (!url) return;
  const frame = document.createElement("iframe");
  frame.id = "__goalsIphonePreview";
  frame.title = "Goals framework preview";
  frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;background:white";
  frame.src = url;
  document.body.appendChild(frame);
}

export function armIphoneClick(button: string, clicked: string): { before: string; label: string; url: string; timeOrigin: number; nonce: string } {
  const target = document.querySelector<HTMLButtonElement>(button);
  const before = document.querySelector(clicked)?.textContent?.trim() ?? "";
  if (!target || target.disabled || !/\b0\b/.test(before)) throw new Error("iPhone counter is not ready at zero");
  target.scrollIntoView({ block: "center" });
  const box = target.getBoundingClientRect();
  if (document.visibilityState !== "visible" || document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) !== target) throw new Error("iPhone counter is not visibly hittable");
  const label = target.getAttribute("aria-label") ?? target.innerText.trim();
  if (!label) throw new Error("iPhone counter has no accessible label");
  const key = globalThis.__goalsIphoneDocument;
  if (!key) throw new Error("Missing iPhone document identity");
  const state = { trusted: false, target };
  Object.assign(globalThis, { __goalsIphoneClick: state });
  target.addEventListener("click", event => { state.trusted = event.isTrusted; }, { once: true });
  return { before, label, ...key };
}
