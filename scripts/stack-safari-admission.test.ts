import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { foreground, ObservationTimeout } from "./goals-matrix/playground";
import type { Admission } from "./goals-matrix/scope";
import type { Transport } from "./goals-matrix/transport";
import { observe, run, withPage } from "../web/tests/browser-stack-safari";

test("the standalone Safari adapter bundles without Playwright runtime dependencies", async () => {
  const result = await Bun.build({ entrypoints: ["web/tests/browser-stack-safari.ts"], target: "bun" });
  expect(result.success).toBe(true);
  const code = await result.outputs[0]!.text();
  expect(code).not.toContain("chromium-bidi");
  expect(code).not.toContain("playwright");
});

function fixture() {
  const finish = Promise.withResolvers<void>();
  const lines = ["$"];
  let stopped = false;
  const shell = { running: false, lastExit: 0, async submit(_text: string) {
    shell.running = true;
    await finish.promise;
    shell.running = false;
    lines.push("$ measurement", "result", "$");
  }, input() { stopped = true; finish.resolve(); } };
  const context = createContext({ crypto, playground: { shell, previews: { serves: () => false },
    term: { write: (_text: string, done: () => void) => done(), buffer: { active: {
      get length() { return lines.length; }, getLine(index: number) { return { isWrapped: false, translateToString: () => lines[index] }; },
    } } },
  } });
  const admissions: Admission[] = [];
  const transport: Transport = { capabilities: {}, async navigate() {}, async openPreview() {}, async useHost() {}, async usePreview() {}, async closePreview() {}, async close() {},
    async evaluate<T>(expression: string, admission: Admission): Promise<T> { admissions.push(admission); return runInContext(expression, context); },
  };
  const signal = new AbortController().signal;
  return { page: { transport, signal }, admissions, finish, stopped: () => stopped };
}

test("Safari measurement prevents a send after its operation deadline", async () => {
  const { page } = fixture();
  const release = Promise.withResolvers<void>();
  const continued = Promise.withResolvers<void>();
  let sent = 0;
  page.transport.evaluate = async (): Promise<never> => { sent++; throw new Error("must not send"); };
  const result = observe(page, 20, async scoped => {
    await release.promise;
    try { return await scoped.evaluate<boolean>("late success"); }
    finally { continued.resolve(); }
  });
  await expect(result).rejects.toBeInstanceOf(ObservationTimeout);
  release.resolve();
  await continued.promise;
  expect(sent).toBe(0);
});

test("Safari measurement never accepts a dispatched observation that succeeds after expiry", async () => {
  const { page } = fixture();
  const evaluate = page.transport.evaluate.bind(page.transport);
  const release = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  page.transport.evaluate = async <T>(expression: string, admission: Admission): Promise<T> => {
    await release.promise;
    try { return await evaluate<T>(expression, admission); }
    finally { settled.resolve(); }
  };
  try {
    await expect(observe(page, 20, scoped => scoped.evaluate("true"))).rejects.toBeInstanceOf(ObservationTimeout);
  } finally { release.resolve(); await settled.promise; }
});

test("foreground polling shares one attempt deadline instead of renewing it", async () => {
  const { page, admissions, finish } = fixture();
  try {
    await expect(observe(page, 140, scoped => foreground(scoped, "pending", 140))).rejects.toBeInstanceOf(ObservationTimeout);
    expect(admissions.length).toBeGreaterThanOrEqual(3);
    expect(new Set(admissions.map(admission => admission.deadline)).size).toBe(1);
    expect(admissions.every(admission => admission.signal.aborted)).toBe(true);
  } finally { finish.resolve(); }
});

test("warm attempts receive new scopes after the previous attempt has expired", async () => {
  const { page, admissions } = fixture();
  await observe(page, 20, scoped => scoped.evaluate("1"));
  await Bun.sleep(30);
  await observe(page, 20, scoped => scoped.evaluate("2"));
  expect(admissions).toHaveLength(2);
  expect(admissions[1]!.deadline).toBeGreaterThan(admissions[0]!.deadline);
  expect(admissions[1]!.signal).not.toBe(admissions[0]!.signal);
});

test("a timed out warm command stops its foreground under a fresh cleanup scope", async () => {
  const { page, admissions, stopped, finish } = fixture();
  try {
    expect(await run(page, "pending", 20)).toEqual({ code: null, output: "$ measurement\nresult" });
    expect(stopped()).toBe(true);
    expect(new Set(admissions.map(admission => admission.signal)).size).toBe(4);
  } finally { finish.resolve(); }
});

test("host cancellation rejects a pending observation with the host reason", async () => {
  const { page } = fixture();
  const controller = new AbortController();
  const reason = new Error("host interrupted");
  const result = observe({ ...page, signal: controller.signal }, 1000, () => new Promise<void>(() => {}));
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
});

test.each(["creation", "observation"])("Safari session teardown runs after host cancellation during %s", async stage => {
  const controller = new AbortController();
  const reason = new Error("host interrupted");
  let deleted = false;
  let navigated = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/session") {
      if (stage === "creation") controller.abort(reason);
      return Response.json({ value: { sessionId: "measurement", capabilities: { browserName: "Safari", platformName: "macOS" } } });
    }
    if (request.method === "DELETE") { deleted = true; return Response.json({ value: null }); }
    if (path.endsWith("/url")) navigated = true;
    if (path.endsWith("/execute/async")) {
      controller.abort(reason);
      return Response.json({ value: { ok: true, json: JSON.stringify({ ready: true, status: "JavaScriptCore ready", engine: "jsc", observedEngine: "jsc", profile: "split" }) } });
    }
    return Response.json({ value: path.endsWith("/window") && request.method === "GET" ? "host" : null });
  } });
  try {
    await expect(withPage({ endpoint: server.url.href, url: "http://fixture/", signal: controller.signal }, "jsc", async () => { throw new Error("must not reach measurement"); })).rejects.toBe(reason);
    expect(deleted).toBe(true);
    expect(navigated).toBe(stage === "observation");
  } finally { await server.stop(true); }
});
