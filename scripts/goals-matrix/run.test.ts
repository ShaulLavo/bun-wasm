import { deadlinePolicy } from "./deadlines";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, access, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { options, run, playgroundURL } from "./run";
import { frameworks, type Browser } from "./catalog";
import { saveReport } from "./report";
import { initialCells, validateReport } from "./model";

test("the actual CLI inventory discovers all missing prerequisites and reaps its real asset server", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-test-"));
  try {
    const root = join(scratch, "site"), output = join(scratch, "report");
    await mkdir(root);
    const result = await run(options([`--root=${root}`, `--output=${output}`, "--asset-source=unit-test-no-assets"]));
    expect(result.cells).toHaveLength(208);
    expect(result.cells.every(cell => cell.status === "not runnable yet" && cell.attempts.length === 0)).toBe(true);
    expect(result.resources).toHaveLength(1);
    const server = result.resources?.[0];
    expect(server?.stopped).toBe(true);
    if (!server) throw new Error("Missing asset server receipt");
    expect(() => process.kill(server.pid, 0)).toThrow();
    await expect(access(join(output, ".goals-matrix-lock"))).rejects.toThrow();
    expect(await Bun.file(join(output, "TABLE.md")).text()).toContain("208");
    const stored = await Bun.file(join(output, "TABLE.json")).json();
    expect(stored.resources[0].stopped).toBe(true);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("a rejected incomplete report never replaces the previous saved report", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-test-"));
  try {
    await Bun.write(join(scratch, "TABLE.json"), "previous result");
    await expect(saveReport(scratch, { schema: 2, run: "test", createdAt: "now", command: "test", deadlines: deadlinePolicy(180_000), source: { commit: "test", dirty: false, assets: {} }, cells: [] })).rejects.toThrow("208");
    expect(await Bun.file(join(scratch, "TABLE.json")).text()).toBe("previous result");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});


test("React Router acceptance opens origin-root previews so server and browser routers see the same path", () => {
  const framework = frameworks.find(item => item.id === "react-router");
  if (!framework) throw new Error("Missing React Router template");
  const url = new URL(playgroundURL("http://127.0.0.1:4173/", framework, "browser"));
  expect(url.searchParams.has("root-previews")).toBe(true);
  expect(url.searchParams.get("template")).toBe(framework.template);
  expect(url.searchParams.get("engine")).toBe("browser");
  expect(url.searchParams.get("mode")).toBe("memory");
});

const loopControls: { browser: Browser; cleanupFails: boolean; firstError: string; stop: boolean }[] = [
  { browser: "safari", cleanupFails: true, firstError: "Original native phase error", stop: true },
  { browser: "iphone-safari", cleanupFails: true, firstError: "Original native phase error", stop: true },
  { browser: "safari", cleanupFails: false, firstError: "Independent framework phase error", stop: false },
  { browser: "chrome", cleanupFails: true, firstError: "Independent framework phase error", stop: false },
  { browser: "iphone-safari", cleanupFails: false, firstError: "T3 device command failed: fixture", stop: true },
];
test.each(loopControls)("two selected cells preserve evidence and resource teardown for %j", async control => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-loop-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await mkdir(join(scratch, "site"));
    await Bun.write(join(scratch, "control.ts"), loopControl(scratch, control));
    const running = Bun.spawn([process.execPath, join(scratch, "control.ts")], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    child = running;
    const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]);
    expect({ code, stderr }, stdout).toEqual({ code: 0, stderr: "" });
    const entered = (await Bun.file(join(scratch, "entered")).text()).trim().split("\n");
    expect(entered).toEqual(control.stop ? ["nuxt"] : ["nuxt", "astro"]);
    const outcome = await Bun.file(join(scratch, "outcome")).text();
    if (!control.stop) expect(outcome).toBe("");
    if (control.stop && control.cleanupFails) expect(outcome).toContain("cleanup failed; stopping before another cell:");
    if (control.stop && !control.cleanupFails) expect(outcome).toBe(`Error: Error: ${control.firstError}`);
    const stored: unknown = await Bun.file(join(scratch, "report/TABLE.json")).json();
    validateReport(stored);
    const first = stored.cells.find(cell => cell.browser === control.browser && cell.engine === "browser" && cell.framework === "nuxt");
    expect(first).toMatchObject({ status: "fail", phase: "startup", error: `Error: ${control.firstError}` });
    expect(first?.attempts).toHaveLength(1);
    expect(first?.attempts[0]?.phases.map(phase => [phase.phase, phase.status])).toEqual([["startup", "fail"], ["cleanup", control.cleanupFails ? "fail" : "pass"]]);
    if (control.cleanupFails) expect(first?.attempts[0]?.phases.at(-1)).toMatchObject({ error: expect.stringContaining("Original cleanup error") });
    const untouched = initialCells().filter(cell => cell.browser !== control.browser || cell.engine !== "browser" || cell.framework !== "nuxt");
    if (control.stop) expect(stored.cells.filter(cell => cell !== first)).toEqual(untouched);
    if (!control.stop) expect(stored.cells.find(cell => cell.browser === control.browser && cell.engine === "browser" && cell.framework === "astro")).toMatchObject({ status: "fail", attempts: expect.any(Array) });
    expect(await Bun.file(join(scratch, "report/logs/nuxt-" + control.browser + "-browser.log")).text()).toContain("Fixture observation unavailable");
    const ownershipFiles = (await readdir(join(scratch, "report/logs"))).filter(name => name.includes(".ownership-"));
    expect(ownershipFiles).toHaveLength(control.browser === "chrome" ? 0 : control.stop ? 1 : 2);
    if (ownershipFiles[0]) expect(JSON.parse((await Bun.file(join(scratch, "report/logs", ownershipFiles[0])).text()).trim())).toMatchObject({ schema: 1, run: stored.run, source: { commit: stored.source.commit, dirty: stored.source.dirty }, attempt: 1, operation: { kind: "session-create" }, outcome: { state: "intent" } });
    expect(stored.resources).toHaveLength(1);
    for (const resource of stored.resources ?? []) {
      expect(resource.stopped).toBe(true);
      expect(() => process.kill(resource.pid, 0)).toThrow();
    }
    await expect(access(join(scratch, "report/.goals-matrix-lock"))).rejects.toThrow();
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child) await child.exited;
    await rm(scratch, { recursive: true, force: true });
  }
}, 15_000);

function loopControl(scratch: string, control: typeof loopControls[number]): string {
  return `import { mock } from "bun:test";
import { appendFile } from "node:fs/promises";
import type { Transport } from ${JSON.stringify(join(import.meta.dir, "scoped-transport.ts"))};
const source = ${JSON.stringify(import.meta.dir)};
const root = ${JSON.stringify(scratch)};
const control = ${JSON.stringify(control)};
const scoped = await import(source + "/scoped-transport.ts");
const createTransport = async (): Promise<Transport> => ({
  capabilities: { browserName: control.browser, transport: "local-control" },
  navigate: async url => { await appendFile(root + "/entered", new URL(url).searchParams.get("template") + "\\n"); throw new Error(control.firstError); },
  evaluate: async () => { throw new Error("Fixture observation unavailable"); },
  openPreview: async () => {}, useHost: async () => {}, usePreview: async () => {}, closePreview: async () => {}, close: async () => {},
  cleanup: async () => { if (control.cleanupFails) throw new Error("Original cleanup error"); return { browserClosed: true, foregroundStopped: true, previewClosed: true }; },
});
mock.module(source + "/discovery.ts", () => ({ prerequisites: () => undefined }));
mock.module(source + "/transport.ts", () => ({ ...scoped, createPlaywrightTransport: createTransport }));
mock.module(source + "/safari-transport.ts", () => ({ createSafariTransport: async options => { options.ownershipSink?.({ sequence: 1, event: 1, at: new Date().toISOString(), sessionId: null, hostHandle: null, admission: "unscoped", operation: { kind: "session-create" }, outcome: { state: "intent" } }); return createTransport(); } }));
const { run, options } = await import(source + "/run.ts");
let failure = "";
try { await run(options(["--root=" + root + "/site", "--output=" + root + "/report", "--asset-source=local-control-no-assets", "--safari-ownership", "--browsers=" + control.browser, "--engines=browser", "--frameworks=nuxt,astro", "--safari-endpoint=http://127.0.0.1:1", "--iphone-endpoint=http://127.0.0.1:1"])); }
catch (error) { failure = String(error); }
await Bun.write(root + "/outcome", failure);
`;
}
