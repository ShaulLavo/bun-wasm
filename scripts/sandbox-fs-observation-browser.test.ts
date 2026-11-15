import { afterEach, expect, spyOn, test } from "bun:test";
import { firefox, type Page, type BrowserContext } from "playwright";
import { resolve, join } from "node:path";
import { verifySite } from "./browser-guest-site";
import { session } from "../web/tests/playground.mjs";
import { storageEvidence, type StorageLifetime } from "./storage-browser-evidence";

const lifetimes: StorageLifetime[] = [];
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) { await lifetime.cleanup(); lifetime.assertClean(); }
});
async function snapshot(page: Page): Promise<object[]> {
  return page.evaluate(() => Reflect.get(globalThis, "__bunwasmStorageFirstEventSnapshot")());
}
async function command(page: Page, text: string): Promise<void> {
  await page.evaluate(text => {
    const shell = Reflect.get(Reflect.get(globalThis, "playground"), "shell");
    Reflect.set(globalThis, "observationControlDone", false);
    void shell.submit(text).then(() => Reflect.set(globalThis, "observationControlDone", true));
  }, text);
  await page.waitForFunction(() => Reflect.get(globalThis, "observationControlDone"), undefined, { timeout: 120_000 });
  expect(await page.evaluate(() => Reflect.get(Reflect.get(globalThis, "playground"), "shell").lastExit)).toBe(0);
}
function endpoint(row: object) {
  if (!("snapshot" in row) || !row.snapshot || typeof row.snapshot !== "object") return;
  const snapshot = row.snapshot;
  if (!("owner" in snapshot) || !("generation" in snapshot) || !("endpoint" in snapshot) || !("handlersQualified" in snapshot)) return;
  if (!("documentId" in row) || !("runtimeId" in row) || !("workerId" in row)) return;
  return { documentId: row.documentId, runtimeId: row.runtimeId, workerId: row.workerId, owner: snapshot.owner, generation: snapshot.generation, endpoint: snapshot.endpoint, qualified: snapshot.handlersQualified };
}
function entries(rows: object[], entry: string): object[] {
  return rows.filter(row => "process" in row && row.process && typeof row.process === "object" && "entry" in row.process && row.process.entry === entry);
}
test("Firefox: installed observation covers original root and successful Bun, shell and selected terminal Preview1 entries", async () => {
  const requested = process.env.BUN_WASM_TEST_BROWSERS;
  if (requested && !requested.split(",").some(name => name === "chromium" || name === "firefox")) return;
  const lifetime = storageEvidence(process.env.BUN_WASM_STORAGE_CONTROL_PROGRESS);
  lifetimes.push(lifetime);
  const task = session("bun-wasm-fs-control-");
  lifetime.own("session.cleanup", () => task.cleanup());
  let url = process.env.BUN_WASM_STORAGE_DEVELOPMENT_URL;
  if (!url) {
    const directory = resolve(process.env.BUN_WASM_BROWSER_SITE ?? "");
    verifySite(directory);
    const previous = process.env.ROOT;
    lifetime.own("root.restore", () => { if (previous === undefined) delete process.env.ROOT; else process.env.ROOT = previous; });
    process.env.ROOT = join(directory, "site");
    url = await task.serve();
  } else if (process.env.CI) throw Error("CI must use the original producer site");
  let context: BrowserContext | undefined;
  const { value: browser } = await lifetime.acquire("browser.launch", () => firefox.launch(), async browser => {
    try { await context?.close(); } finally { await browser.close(); }
  });
  context = await browser.newContext();
  // This control is always selected, including local runs without a progress artifact.
  await context.addInitScript(() => Reflect.set(globalThis, "__bunwasmStorageFirstEvent", true));
  await lifetime.observeContext(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", async message => { if (message.type() === "error") console.error("control page error", await Promise.all(message.args().map(arg => arg.evaluate(value => value instanceof Error ? { message: value.message, stack: value.stack } : String(value))))); });
  const failures: string[] = [];
  page.on("console", message => { if (message.text().startsWith("[storage-fs-first-event] ")) failures.push(message.text()); });
  await page.goto(url + "?mode=memory&engine=browser&prompt=off", { timeout: 120_000 });
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, "playground")), undefined, { timeout: 120_000 });
  const root = await snapshot(page);
  expect(root.some(row => "workerId" in row && row.workerId === null && "process" in row && row.process === null)).toBe(true);
  for (const [entry, text] of [["bun", "bun -e 'console.log(17+19)'"], ["shell", "/bin/bash -c 'echo 47'"], ["preview1", "/bin/env"]]) {
    await command(page, text!);
    const rows = await snapshot(page);
    lifetime.event("filesystem-positive-control", { entry, rows });
    const observed = entries(rows, entry!);
    expect(observed.length).toBeGreaterThan(0);
    expect(JSON.stringify(observed)).toContain('"requestSends":1');
    if (entry === "preview1") expect(JSON.stringify(observed)).toContain('"executorBranch":"terminal"');
    const client = observed.map(endpoint).find(value => value?.qualified);
    expect(client).toBeDefined();
    if (!client) throw Error("No qualified original client");
    expect(rows.map(endpoint).some(peer => peer?.qualified && peer.endpoint === "service" && peer.documentId === client?.documentId && peer.runtimeId === client.runtimeId && peer.owner === client.owner && peer.generation === client.generation)).toBe(true);
    expect(rows.some(row => "snapshot" in row && row.snapshot && typeof row.snapshot === "object" && "endpoint" in row.snapshot && row.snapshot.endpoint === "service")).toBe(true);
  }
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
  const journal = spyOn(lifetime, "event");
  try {
    lifetime.event("error", { phase: "labelled-retention-control", synthetic: true });
    const retained = journal.mock.calls.find(([kind]) => kind === "filesystem-retained");
    expect(retained).toBeDefined();
    expect(JSON.stringify(retained)).toContain('"recentPerPage":32');
    expect(JSON.stringify(retained)).toContain('"documentId"');
  } finally { journal.mockRestore(); }
}, 240_000);
