import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { processBundle } from "../scripts/ci-process-bundles";
import { processFixture } from "./process-fixtures";
import { automaticChecks } from "../../scripts/test-checks";
import { joinProcessBundleProducer, prepareProcessAssets, prepareProcessBundle, processDirectoryAssets } from "./process-page-assets";

let root: string | undefined;
let produced: Promise<Record<string, Blob>> | undefined;
let assets: Record<string, Blob>;
const preparation = new AbortController();

function directory(path: string): string {
  if (!root) throw new Error("process asset fixture not initialized");
  return join(root, path);
}

async function withCaptured<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.BUN_WASM_PROCESS_BUNDLES;
  process.env.BUN_WASM_PROCESS_BUNDLES = path;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.BUN_WASM_PROCESS_BUNDLES;
    else process.env.BUN_WASM_PROCESS_BUNDLES = previous;
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "process-assets-"));
  await mkdir(directory("original"));
  produced = prepareProcessAssets({ scratch: directory("original"), signal: preparation.signal });
  assets = await produced;
}, 30_000);

afterAll(async () => {
  preparation.abort();
  await produced?.catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function checkCompleteMap(map: Record<string, Blob>, out: string): Promise<void> {
  const files = Array.from(new Bun.Glob("**/*").scanSync({ cwd: out, onlyFiles: true, dot: true }));
  const expected = files.map(path => "/current/" + path.split("/").map(encodeURIComponent).join("/"));
  expected.sort();
  expect(Object.keys(map).sort()).toEqual(expected);
  for (const file of files) {
    const url = "/current/" + file.split("/").map(encodeURIComponent).join("/");
    const blob = map[url];
    if (!blob) throw new Error(`asset absent: ${url}`);
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.bytes()).toEqual(await Bun.file(join(out, file)).bytes());
  }
}

test("the actual supervisor producer maps every output without running the 23-case page", async () => {
  await checkCompleteMap(assets, directory("original/current"));
  for (const entry of ["index.html", "process-browser-main.js", "worker.js", "fs-worker.js", "notification-worker.js", "preview1-worker.js"]) expect(assets[`/current/${entry}`]).toBeDefined();
  const paths = Object.keys(assets);
  expect(paths.some(path => path.startsWith("/current/chunks/") && path.endsWith(".js"))).toBe(true);
  expect(paths.some(path => path.startsWith("/current/__bunwasm/chunks/") && path.endsWith(".js.map"))).toBe(true);
  expect(assets["/current/__bunwasm/fs-worker.js"]?.type.split(";")[0]).toBe("text/javascript");
  expect(assets["/current/index.html"]?.type.split(";")[0]).toBe("text/html");
  expect(assets["/current/"]).toBeUndefined();
  expect(assets["/report"]).toBeUndefined();
});

test("the existing captured supervisor branch remains a complete copy and still returns void", async () => {
  const captured = directory("captured");
  const supervisor = join(captured, "supervisor");
  await cp(directory("original/current"), supervisor, { recursive: true });
  await Bun.write(join(supervisor, "control.json"), '{"captured":true}');
  await Bun.write(join(supervisor, "tiny.wasm"), processFixture("exit"));
  await Bun.write(join(supervisor, ".hidden/fixture.js.map"), '{"version":3}');
  await Bun.write(join(supervisor, "__bunwasm/chunks/nested/extra.js.map"), '{"version":3}');
  await Bun.write(join(supervisor, "chunks/space #?.js"), "export const fixture = true;");
  await mkdir(directory("captured-host"));
  const map = await withCaptured(captured, async () => {
    expect(await processBundle("supervisor", directory("direct-copy"))).toBeUndefined();
    return prepareProcessAssets({ scratch: directory("captured-host"), signal: new AbortController().signal });
  });
  await checkCompleteMap(map, supervisor);
  for (const [path, type] of new Map([["control.json", "application/json"], ["tiny.wasm", "application/wasm"], [".hidden/fixture.js.map", "application/json"], ["__bunwasm/chunks/nested/extra.js.map", "application/json"]])) {
    const blob = map[`/current/${path}`];
    if (!blob) throw new Error(`captured asset absent: ${path}`);
    expect(new Response(blob).headers.get("Content-Type")?.split(";")[0]).toBe(type);
  }
  expect(await map["/current/chunks/space%20%23%3F.js"]?.text()).toBe("export const fixture = true;");
  expect(await Bun.file(join(supervisor, "control.json")).text()).toBe('{"captured":true}');
});

test("mapping stays lazy and does not follow foreign symlinks", async () => {
  const out = directory("lazy");
  await Bun.write(join(out, "value.txt"), "before");
  const map = await processDirectoryAssets(out, new AbortController().signal);
  await Bun.write(join(out, "value.txt"), "after");
  expect(await map["/current/value.txt"]?.text()).toBe("after");
  const foreign = directory("foreign.txt");
  await Bun.write(foreign, "owner sentinel");
  await symlink(foreign, join(out, "foreign.txt"));
  await expect(processDirectoryAssets(out, new AbortController().signal)).rejects.toThrow("non-file");
  await symlink(out, directory("linked-root"));
  await expect(processDirectoryAssets(directory("linked-root"), new AbortController().signal)).rejects.toThrow("not a link");
  expect(await Bun.file(foreign).text()).toBe("owner sentinel");
});

test("already aborted preparation creates no output and cannot overwrite an existing current directory", async () => {
  const scratch = directory("aborted");
  await mkdir(scratch);
  const controller = new AbortController();
  const reason = new Error("aborted before allocation");
  controller.abort(reason);
  await expect(prepareProcessAssets({ scratch, signal: controller.signal })).rejects.toBe(reason);
  expect(existsSync(join(scratch, "current"))).toBe(false);
  await Bun.write(join(scratch, "current/sentinel.txt"), "foreign output");
  await expect(prepareProcessAssets({ scratch, signal: new AbortController().signal })).rejects.toThrow("EEXIST");
  expect(await Bun.file(join(scratch, "current/sentinel.txt")).text()).toBe("foreign output");
});

test("cancellation joins the actual spawned producer before rejecting", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel owned Bun producer");
  const pending = prepareProcessBundle(directory("cancelled-output"), controller.signal);
  try {
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(await Bun.file(directory("cancelled-output/index.html")).exists()).toBe(false);
  } finally {
    controller.abort(reason);
    await pending.catch(() => undefined);
  }
});

test("abort is not producer settlement and host deletion must wait for a late writer to join", async () => {
  const scratch = directory("late-producer");
  const foreign = directory("late-foreign.txt");
  await mkdir(scratch);
  await Bun.write(foreign, "foreign sentinel");
  const release = deferred<void>();
  const events: string[] = [];
  const exited = release.promise.then(async () => { await Bun.write(join(scratch, "late.txt"), "last write"); events.push("joined"); return 137; });
  const controller = new AbortController();
  const reason = new Error("pending producer abort");
  const pending = joinProcessBundleProducer({ exited, kill(signal) { events.push(String(signal)); } }, controller.signal);
  let settled = false;
  const cleaned = pending.finally(async () => { settled = true; events.push("cleanup"); await rm(scratch, { recursive: true }); });
  try {
    controller.abort(reason);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(events).toEqual(["SIGKILL"]);
  } finally {
    release.resolve();
    await expect(cleaned).rejects.toBe(reason);
  }
  expect(events).toEqual(["SIGKILL", "joined", "cleanup"]);
  expect(await Bun.file(join(scratch, "late.txt")).exists()).toBe(false);
  expect(await Bun.file(foreign).text()).toBe("foreign sentinel");
});

test("pre-aborted and nonzero producers still join and remove their abort listeners", async () => {
  const controller = new AbortController();
  const reason = new Error("already cancelled");
  controller.abort(reason);
  const signals: unknown[] = [];
  await expect(joinProcessBundleProducer({ exited: Promise.resolve(0), kill(signal) { signals.push(signal); } }, controller.signal)).rejects.toBe(reason);
  expect(signals).toEqual(["SIGKILL"]);
  const later = new AbortController();
  await expect(joinProcessBundleProducer({ exited: Promise.resolve(7), kill(signal) { signals.push(signal); } }, later.signal)).rejects.toThrow("exited 7");
  later.abort();
  expect(signals).toEqual(["SIGKILL"]);
});

test("a failed kill cannot settle preparation while its producer exit remains unconfirmed", async () => {
  const exit = deferred<number>();
  const controller = new AbortController();
  let settled = false;
  const pending = joinProcessBundleProducer({ exited: exit.promise, kill() { throw new Error("kill failed"); } }, controller.signal);
  const checked = pending.finally(() => { settled = true; });
  try {
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    exit.resolve(0);
    await expect(checked).rejects.toThrow("termination failed before join");
  }
});

test("captured-input failure has no build fallback and preserves foreign files", async () => {
  const scratch = directory("missing-captured");
  await mkdir(scratch);
  await Bun.write(join(scratch, "foreign.txt"), "preserved");
  await withCaptured(directory("absent"), async () => {
    await expect(prepareProcessAssets({ scratch, signal: new AbortController().signal })).rejects.toThrow("producer exited");
  });
  expect(await Bun.file(join(scratch, "foreign.txt")).text()).toBe("preserved");
});

test("an aborted asset-map read does not change output or claim a successful map", async () => {
  const controller = new AbortController();
  const reason = new Error("map cancelled");
  const pending = processDirectoryAssets(directory("original/current"), controller.signal);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(await Bun.file(directory("original/current/index.html")).exists()).toBe(true);
});

test("the new asset controls have the existing automatic Web test owner", () => {
  expect(automaticChecks()).toContainEqual({ owner: "web", path: "web/tests/process-page-assets.test.ts" });
});
