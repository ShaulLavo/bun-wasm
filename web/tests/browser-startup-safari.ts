import assert from "node:assert/strict";

assert.equal(process.platform, "darwin", "Run this check on the Mac fleet host");
const url = process.argv[2];
assert.ok(url, "Pass the URL of a playground built on the PC and served with COOP/COEP headers");
const port = Number(process.env.SAFARI_DRIVER_PORT ?? 43189);
const origin = `http://127.0.0.1:${port}`;
let driver: ReturnType<typeof Bun.spawn> | undefined;
let session: string | undefined;
let cleaning: Promise<void> | undefined;
const report: Record<string, unknown> = { url };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
async function request(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const response = await fetch(origin + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120_000) });
  const result: unknown = await response.json();
  assert.ok(record(result));
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
async function evaluate(script: string): Promise<unknown> {
  const result = await request(`/session/${session}/execute/async`, "POST", {
    script: `const done=arguments[arguments.length-1]; Promise.resolve().then(async()=>{${script}}).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error),stack:error?.stack}));`, args: [],
  });
  assert.ok(record(result));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function ready(): Promise<void> {
  await evaluate("const end=Date.now()+30000; while(!globalThis.playground){if(Date.now()>end)throw Error(document.querySelector('#status')?.textContent||'Startup timed out');await new Promise(r=>setTimeout(r,25));} return true;");
}
async function navigate(): Promise<void> {
  await request(`/session/${session}/url`, "POST", { url });
}
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    if (session) await request(`/session/${session}`, "DELETE").catch(error => { report.sessionCleanupError = String(error); });
    if (driver) { driver.kill(); await driver.exited; }
    report.cleanup = { driverStopped: true, sessionClosed: !report.sessionCleanupError };
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 240_000);
try {
  const occupied = await fetch(`${origin}/status`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  assert.equal(occupied, false, "The Safari driver port must be unused");
  driver = Bun.spawn(["/usr/bin/safaridriver", "--port", String(port)], { stdout: "ignore", stderr: "ignore" });
  for (let attempts = 0; ; attempts++) {
    try { await request("/status"); break; }
    catch (error) { if (attempts === 30) throw error; await Bun.sleep(100); }
  }
  const capabilities = process.env.SAFARI_IOS === "1"
    ? { browserName: "safari", platformName: "ios", "safari:useSimulator": true, "safari:deviceType": "iPhone", "safari:deviceName": "iPhone 17 Pro" }
    : { browserName: "safari" };
  const opened = await request("/session", "POST", { capabilities: { alwaysMatch: capabilities } });
  assert.ok(record(opened) && typeof opened.sessionId === "string");
  session = opened.sessionId;
  report.capabilities = opened.capabilities;
  await request(`/session/${session}/timeouts`, "POST", { script: 120_000, pageLoad: 60_000, implicit: 0 });
  await navigate(); await ready();
  assert.equal(await evaluate("return globalThis.crossOriginIsolated;"), true);
  await evaluate("await playground.fs.writeFile('/safari-startup.txt','durable Safari edit'); await playground.fs.flush('/safari-startup.txt'); return true;");
  for (let reload = 0; reload < 3; reload++) {
    await request(`/session/${session}/refresh`, "POST", {}); await ready();
    assert.equal(await evaluate("return new TextDecoder().decode(await playground.fs.readFile('/safari-startup.txt'));"), "durable Safari edit");
  }
  report.reloads = 3;
  const owner = await request(`/session/${session}/window`);
  const contender = await request(`/session/${session}/window/new`, "POST", { type: "tab" });
  assert.ok(record(contender) && typeof contender.handle === "string");
  await request(`/session/${session}/window`, "POST", { handle: contender.handle });
  await navigate();
  const diagnostic = await evaluate("const end=Date.now()+15000; const status=document.querySelector('#status'); while(status?.dataset.kind!=='error'){if(Date.now()>end)throw Error('Writer contention was not reported');await new Promise(r=>setTimeout(r,25));}return {message:status.textContent,whiteSpace:getComputedStyle(status).whiteSpace,clipped:status.scrollWidth>status.clientWidth||status.scrollHeight>status.clientHeight,retry:document.querySelector('#run')?.textContent,editor:!!globalThis.playground};");
  assert.ok(record(diagnostic) && typeof diagnostic.message === "string");
  assert.match(diagnostic.message, /Filesystem already has a writer in another tab/);
  assert.match(diagnostic.message, /Close that tab, then reload this page/);
  assert.equal(diagnostic.whiteSpace, "pre-wrap"); assert.equal(diagnostic.clipped, false);
  assert.equal(diagnostic.retry, "Reload"); assert.equal(diagnostic.editor, false);
  report.diagnostic = diagnostic;
  if (process.env.SAFARI_SCREENSHOT) {
    const screenshot = await request(`/session/${session}/screenshot`);
    assert.equal(typeof screenshot, "string");
    if (typeof screenshot === "string") await Bun.write(process.env.SAFARI_SCREENSHOT, Buffer.from(screenshot, "base64"));
  }
  await request(`/session/${session}/window`, "POST", { handle: owner });
  await request(`/session/${session}/window`, "DELETE");
  await request(`/session/${session}/window`, "POST", { handle: contender.handle });
  await request(`/session/${session}/refresh`, "POST", {});
  await ready();
  assert.equal(await evaluate("return new TextDecoder().decode(await playground.fs.readFile('/safari-startup.txt'));"), "durable Safari edit");
  await evaluate("await playground.fs.remove('/safari-startup.txt'); await playground.fs.flush(); return true;");
  report.recovered = true;
  report.ok = true;
  console.log("Safari playground: fresh startup, three durable reloads, complete writer error and retry passed");
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  clearTimeout(deadline); await cleanup();
  if (process.env.SAFARI_OUTPUT) await Bun.write(process.env.SAFARI_OUTPUT, JSON.stringify(report, null, 2) + "\n");
}
