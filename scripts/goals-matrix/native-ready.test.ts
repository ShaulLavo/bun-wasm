import { expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { bounded } from "./bounded";
import { waitNativeReady } from "./native-ready";

const message = { iphoneControl: "http://127.0.0.1:1234/fixture", productOrigin: "http://127.0.0.1:4321" };
const record = JSON.stringify(message);

async function fixture(operation: (f: ReturnType<typeof files>) => Promise<void>): Promise<void> {
  const f = files();
  try { await operation(f); }
  finally { f.controller.abort(); for (const watcher of f.watchers) watcher.close(); rmSync(f.root, { recursive: true, force: true }); }
}

function files() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-native-ready-"));
  const controller = new AbortController();
  const watchers: FSWatcher[] = [];
  const closes: ReturnType<typeof spyOn<FSWatcher, "close">>[] = [];
  const options = { logFile: join(root, "queue.log"), exitFile: join(root, "queue.exit"), errorFile: join(root, "server.error"), timeoutMs: 1000, signal: controller.signal };
  const observe = (directory: string, changed: () => void) => {
    const watcher = watch(directory, changed);
    closes.push(spyOn(watcher, "close"));
    watchers.push(watcher);
    return watcher;
  };
  const cleaned = () => {
    expect(watchers.length).toBeGreaterThan(0);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  };
  return { root, options, controller, watchers, observe, cleaned };
}

test("ready record present before waiting closes its observer and deadline timer", () => fixture(async f => {
  writeFileSync(f.options.logFile, record + "\n");
  const scheduled = spyOn(globalThis, "setTimeout"), cleared = spyOn(globalThis, "clearTimeout");
  try {
    expect(await waitNativeReady(f.options, f.observe)).toEqual(message);
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(cleared).toHaveBeenCalledWith(scheduled.mock.results[0]?.value);
    f.cleaned();
  } finally { scheduled.mockRestore(); cleared.mockRestore(); }
}));

test("record written during observer setup is re-read without any notification", () => fixture(async f => {
  let notifications = 0;
  const observe = (directory: string, changed: () => void) => {
    writeFileSync(f.options.logFile, record);
    return f.observe(directory, () => { notifications++; changed(); });
  };
  expect(await waitNativeReady(f.options, observe)).toEqual(message);
  expect(notifications).toBe(0);
  f.cleaned();
}));

test("incomplete CLI JSON stays pending until a real file notification completes it", () => fixture(async f => {
  writeFileSync(f.options.logFile, 'queue acquired\n{"iphoneControl":');
  let changed: () => void = () => { throw new Error("Observer not installed"); };
  const waiting = waitNativeReady(f.options, (directory, callback) => { changed = callback; return f.observe(directory, callback); });
  let settled = false;
  void waiting.then(() => { settled = true; }, () => { settled = true; });
  changed();
  await Promise.resolve();
  expect(settled).toBe(false);
  appendFileSync(f.options.logFile, record.slice('{"iphoneControl":'.length) + "\n");
  expect(await waiting).toEqual(message);
  f.cleaned();
}));

for (const state of ["error", "exit", "json-error"]) {
  test(`${state} already present fails and releases resources`, () => fixture(async f => {
    if (state === "error") writeFileSync(f.options.errorFile, "");
    if (state === "exit") writeFileSync(f.options.exitFile, "0\n");
    if (state === "json-error") writeFileSync(f.options.logFile, '{"error":"fixture failure"}\n');
    await expect(waitNativeReady(f.options, f.observe)).rejects.toThrow(state === "exit" ? "Queue exited" : "error");
    f.cleaned();
  }));
}

test("terminal markers win over a stale ready record", () => fixture(async f => {
  writeFileSync(f.options.logFile, record);
  writeFileSync(f.options.exitFile, "1");
  await expect(waitNativeReady(f.options, f.observe)).rejects.toThrow("Queue exited");
  f.cleaned();
}));

test("queue exit arriving after registration wakes the waiter", () => fixture(async f => {
  const waiting = waitNativeReady(f.options, f.observe);
  writeFileSync(f.options.exitFile, "7\n");
  await expect(waiting).rejects.toThrow("Queue exited");
  f.cleaned();
}));

test("cancellation closes observers and clears the deadline timer", () => fixture(async f => {
  const scheduled = spyOn(globalThis, "setTimeout"), cleared = spyOn(globalThis, "clearTimeout");
  try {
    const waiting = waitNativeReady(f.options, f.observe);
    f.controller.abort(new Error("fixture cancelled"));
    await expect(waiting).rejects.toThrow("fixture cancelled");
    expect(cleared).toHaveBeenCalledWith(scheduled.mock.results[0]?.value);
    f.cleaned();
  } finally { scheduled.mockRestore(); cleared.mockRestore(); }
}));

test("cancellation during observer setup is noticed without another abort event", () => fixture(async f => {
  const observe = (directory: string, changed: () => void) => {
    const watcher = f.observe(directory, changed);
    f.controller.abort(new Error("cancelled during setup"));
    return watcher;
  };
  await expect(waitNativeReady(f.options, observe)).rejects.toThrow("cancelled during setup");
  f.cleaned();
}));

test("an already cancelled wait opens no observers", () => fixture(async f => {
  f.controller.abort(new Error("cancelled before setup"));
  await expect(waitNativeReady(f.options, f.observe)).rejects.toThrow("cancelled before setup");
  expect(f.watchers).toHaveLength(0);
  expect(getEventListeners(f.controller.signal, "abort")).toHaveLength(0);
}));

test("the observation deadline closes watchers even when no files ever appear", () => fixture(async f => {
  await expect(waitNativeReady({ ...f.options, timeoutMs: 1 }, f.observe)).rejects.toThrow("timed out");
  f.cleaned();
}));

test("watcher errors and partial observer installation close every installed watcher", () => fixture(async f => {
  const waiting = waitNativeReady(f.options, f.observe);
  f.watchers[0]?.emit("error", new Error("watch failed"));
  await expect(waiting).rejects.toThrow("watch failed");
  f.cleaned();
  f.watchers.length = 0;
  await expect(waitNativeReady({ ...f.options, exitFile: join(f.root, "absent", "queue.exit") }, f.observe)).rejects.toThrow("ENOENT");
  expect(f.watchers).toHaveLength(1);
  f.cleaned();
}));

test("read errors fail instead of waiting for another notification", () => fixture(async f => {
  await expect(waitNativeReady({ ...f.options, logFile: f.root }, f.observe)).rejects.toThrow();
  f.cleaned();
}));

test("the CLI returns existing JSON and exits without keeping its deadline alive", () => fixture(async f => {
  writeFileSync(f.options.logFile, record);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "native-ready.ts"), "--log-file", f.options.logFile, "--exit-file", f.options.exitFile, "--timeout-ms", "60000"], { stdout: "pipe", stderr: "pipe" });
  try {
    const [code, output, errors] = await bounded(() => Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]), 2000);
    expect({ code, output, errors }).toEqual({ code: 0, output: record + "\n", errors: "" });
    expect(readFileSync(f.options.logFile, "utf8")).toBe(record);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}));
