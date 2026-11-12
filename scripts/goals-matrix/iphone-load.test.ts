import { expect, test } from "bun:test";
import { object } from "./evidence";
import { createIphoneTransport } from "./iphone-transport";

type Row = Record<string, unknown>;
type Script = { states: Row[]; loads: Row[]; focuses: Row[] };
const url = "http://127.0.0.1:1234/preview";
const configured = { url, nonce: "preview-nonce", visible: false };
const attached = { ...configured, visible: true, timeOrigin: 10 };
const loading = { loaded: false, readyState: "interactive" };
const complete = { loaded: true, readyState: "complete" };
const unfocused = { presented: true, focused: false };
const focusedFrame = { presented: true, focused: true };
const unhydrated = { ready: false, before: "0" };

/** A scripted controller: each list answers in order and then repeats its last row. */
async function withControl(script: Script, timeoutMs: number, action: (transport: Awaited<ReturnType<typeof createIphoneTransport>>, log: string[]) => Promise<void>): Promise<void> {
  const log: string[] = [];
  const next = (rows: Row[]): Row | undefined => rows.length > 1 ? rows.shift() : rows[0];
  const answers: Record<string, () => unknown> = {
    presentIphonePreview: () => null, iphonePreviewLoad: () => next(script.loads), iphonePreviewFocus: () => next(script.focuses), armIphoneClick: () => unhydrated,
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    const route = new URL(request.url).pathname.split("/").slice(3).join("/");
    if (request.method === "GET") { log.push(route); return Response.json(next(script.states)); }
    const row = object(await request.json());
    if (route === "preview/configure") { log.push(route); return Response.json(url); }
    const name = Object.keys(answers).find(candidate => String(row.source).includes("function " + candidate));
    if (!name) throw new Error("Unexpected controller expression");
    log.push(`${route} ${name}${row.observation === true ? " observation" : ""}`);
    return Response.json(answers[name]?.() ?? null);
  } });
  const transport = await createIphoneTransport({ control: server.url.origin + "/__goals_iphone/" + "f".repeat(64), agent: "/bound/agent-device", deviceUDID: "fixture", timeoutMs });
  try { await action(transport, log); }
  finally { await transport.close(); await server.stop(true); }
}

test("opening a preview waits in the preview document and reads the owner only to confirm focus", async () => {
  const script = { states: [configured, configured, attached], loads: [loading, loading, complete], focuses: [unfocused, focusedFrame] };
  await withControl(script, 2000, async (transport, log) => {
    await transport.openPreview(url);
    expect(log).toEqual([
      "preview/configure", "host/execute presentIphonePreview",
      "preview/state", "preview/state", "preview/state",
      "preview/execute iphonePreviewLoad observation", "preview/execute iphonePreviewLoad observation", "preview/execute iphonePreviewLoad observation",
      "host/execute iphonePreviewFocus", "host/execute iphonePreviewFocus",
    ]);
  });
});

test("a preview document that never attaches expires without holding any observer command", async () => {
  await withControl({ states: [configured], loads: [complete], focuses: [focusedFrame] }, 300, async (transport, log) => {
    await expect(transport.openPreview(url)).rejects.toThrow(`iPhone preview document did not finish within 300 ms; last observation: ${JSON.stringify(configured)}`);
    expect(log.filter(entry => entry.includes("/execute"))).toEqual(["host/execute presentIphonePreview"]);
    const settled = log.length;
    await Bun.sleep(250);
    expect(log).toHaveLength(settled);
  });
});

test("a preview that attaches but never completes loading never reads owner focus", async () => {
  await withControl({ states: [attached], loads: [loading], focuses: [focusedFrame] }, 300, async (transport, log) => {
    await expect(transport.openPreview(url)).rejects.toThrow(`iPhone preview load did not finish within 300 ms; last observation: ${JSON.stringify(loading)}`);
    expect(log.filter(entry => entry.startsWith("host/execute"))).toEqual(["host/execute presentIphonePreview"]);
    await expect(transport.nativeClick!("button", "output", 200)).rejects.toThrow("not focused after load");
    expect(log.some(entry => entry.includes("armIphoneClick"))).toBe(false);
  });
});

test("a loaded preview whose frame was never focused expires without native input", async () => {
  await withControl({ states: [attached], loads: [complete], focuses: [unfocused] }, 300, async (transport, log) => {
    await expect(transport.openPreview(url)).rejects.toThrow(`iPhone preview focus did not finish within 300 ms; last observation: ${JSON.stringify(unfocused)}`);
    await expect(transport.nativeClick!("button", "output", 200)).rejects.toThrow("not focused after load");
    expect(log.some(entry => entry.includes("armIphoneClick"))).toBe(false);
  });
});

test("native input is accepted only between a completed opening and the next presentation change", async () => {
  await withControl({ states: [attached], loads: [complete], focuses: [focusedFrame] }, 1000, async (transport, log) => {
    const arms = () => log.filter(entry => entry.includes("armIphoneClick")).length;
    await expect(transport.nativeClick!("button", "output", 200)).rejects.toThrow("not focused after load");
    expect(log).toEqual([]);
    await transport.openPreview(url);
    // The gate is open: arming polls the unhydrated fixture counter until the click deadline.
    await expect(transport.nativeClick!("button", "output", 150)).rejects.toThrow();
    const polled = arms();
    expect(polled).toBeGreaterThan(0);
    await transport.closePreview();
    await expect(transport.nativeClick!("button", "output", 200)).rejects.toThrow("not focused after load");
    expect(arms()).toBe(polled);
  });
});
