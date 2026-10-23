import assert from "node:assert/strict";
import { allocateSafariDriverPort, ownSafariDriver, stopSafariDriver } from "./engine-interruption-safari";

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
export function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

type WebDriverRequest = (path: string, body?: unknown, method?: string) => Promise<unknown>;
async function waitForDriver(request: WebDriverRequest, driver: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; ; attempt++) {
    try { await request("/status"); return; }
    catch (error) { if (attempt >= 40 || driver.exitCode !== null) throw error; await Bun.sleep(100); }
  }
}
async function waitForResult(request: WebDriverRequest, path: string, name: string, timeout = 90_000) {
  const end = Date.now() + timeout;
  let nextProgress = Date.now() + 10_000;
  while (Date.now() < end) {
    const value = await request(path, { script: "return globalThis[arguments[0]] ?? null;", args: [name] });
    if (value !== null) return object(value);
    if (Date.now() >= nextProgress) {
      console.log(JSON.stringify({ waitingFor: name, progress: await request(path, { script: "return globalThis.engineInterruptionProgress?.() ?? globalThis.processProgress?.() ?? null", args: [] }) }));
      nextProgress = Date.now() + 10_000;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Result timed out: ${name}`);
}

/** Real Safari only. Session deletion never touches the owner's normal windows. */
export async function safariDriver() {
  assert.equal(process.platform, "darwin", "Reserve the Mac before running real Safari");
  const port = await allocateSafariDriverPort();
  const started = Date.now();
  const driver = Bun.spawn(["/usr/bin/safaridriver", "--port", String(port)], { stdout: "ignore", stderr: "inherit" });
  const owned = ownSafariDriver(driver, started, port);
  let session: string | undefined;
  let closing = false;
  async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(closing ? 5_000 : 125_000) });
    const envelope = object(await response.json());
    assert.equal(response.ok, true, JSON.stringify(envelope));
    return envelope.value;
  }
  async function close() {
    closing = true;
    try { if (session) await request(`/session/${session}`, undefined, "DELETE"); }
    finally { await stopSafariDriver(owned, port); await driver.exited; }
  }
  async function evaluate(script: string, args: unknown[] = []): Promise<unknown> {
    const result = object(await request(`/session/${session}/execute/async`, {
      script: `const done=arguments[arguments.length-1];Promise.resolve().then(async()=>{${script}}).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)+"\\n"+String(error.stack||"" )}));`, args,
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  }
  async function navigate(url: string) {
    await request(`/session/${session}/url`, { url });
    // Safari can acknowledge navigation before replacing the previous document.
    for (let attempt = 0; attempt < 600; attempt++) {
      const state = object(await request(`/session/${session}/execute/sync`, { script: "return {url:location.href,ready:document.readyState}", args: [] }));
      if (state.url === url && state.ready === "complete") return;
      await Bun.sleep(25);
    }
    throw new Error(`Safari navigation did not complete: ${url}`);
  }
  try {
    await waitForDriver(request, driver);
    const opened = object(await request("/session", { capabilities: { alwaysMatch: { browserName: "safari" } } }));
    assert.equal(typeof opened.sessionId, "string");
    assert.ok(typeof opened.sessionId === "string"); session = opened.sessionId;
    await request(`/session/${session}/timeouts`, { script: 120_000, pageLoad: 30_000, implicit: 0 });
    return { capabilities: opened.capabilities, port, pid: driver.pid, evaluate, navigate, close,
      result: (name: string, timeout?: number) => waitForResult(request, `/session/${session}/execute/sync`, name, timeout),
      async controlC() {
        await request(`/session/${session}/actions`, { actions: [{ type: "key", id: "terminal", actions: [
          { type: "keyDown", value: "\uE009" }, { type: "keyDown", value: "c" },
          { type: "keyUp", value: "c" }, { type: "keyUp", value: "\uE009" },
        ] }] });
      },
      async reload() { await request(`/session/${session}/refresh`, {}); },
    };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `Safari startup failed: ${String(error)}; cleanup: ${String(cleanupError)}`); }
    throw error;
  }
}
