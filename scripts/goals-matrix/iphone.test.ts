import { test, expect } from "bun:test";
import { IphoneBus } from "./iphone-bus";
import { createIphoneTransport, nativeButtonRef, validateIphoneControl } from "./iphone-transport";
import { checkClick } from "./playground";
import { withPlayground } from "./test-fixture";
import { frameworks } from "./catalog";
import { closeIphoneTab } from "./iphone-cleanup";
import { ownedCommand } from "./lifetime";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("visible iPhone options reject SafariDriver-shaped or non-loopback controls", () => {
  validateIphoneControl("http://127.0.0.1:1234/__goals_iphone/" + "a".repeat(64), "/bound/agent-device");
  expect(() => validateIphoneControl("http://remote:1234/session", "/bound/agent-device")).toThrow();
  expect(() => validateIphoneControl("http://127.0.0.1:1234/__goals_iphone/" + "a".repeat(64), "agent-device")).toThrow();
  expect(nativeButtonRef('@e1 [button] "Count 0"\n@e2 [button] "Other"', "Count 0")).toBe("@e1");
  expect(() => nativeButtonRef('@e1 [button] "Count 0"\n@e2 [button] "Count 0"', "Count 0")).toThrow("found 2");
});

test("native click hook bypasses the script click without changing other transports", async () => {
  const framework = frameworks[0]!;
  await withPlayground(framework, 0, async transport => {
    let native = 0;
    transport.nativeClick = async () => { native++; return { before: "0", after: "1", trusted: true }; };
    expect(await checkClick(transport, framework, 90000)).toEqual({ before: "0", after: "1", trusted: true });
    expect(native).toBe(1);
    delete transport.nativeClick;
    expect(await checkClick(transport, framework, 90000)).toEqual({ before: "count 0", after: "count 1" });
  });
});

test("bus rejects wrong documents, stale replies and expired commands", async () => {
  const bus = new IphoneBus("/test");
  bus.configure("host", "http://127.0.0.1:1234/");
  const state = bus.state("host")!;
  const key = { nonce: state.nonce, url: state.url, timeOrigin: 1, visible: true };
  expect(() => bus.poll("host", { ...key, nonce: "wrong" }, "http://127.0.0.1:1234")).toThrow();
  bus.poll("host", key, "http://127.0.0.1:1234");
  const pending = bus.execute("host", "1", 20);
  const rejected = expect(pending).rejects.toThrow("expired");
  await rejected;
  expect(() => bus.reply("host", { ...key, id: 1, ok: true, value: 1 }, "http://127.0.0.1:1234")).toThrow("Late");
  expect(() => bus.poll("host", { ...key, timeOrigin: 2 }, "http://127.0.0.1:1234")).toThrow("replaced");
  bus.close();
});

test("native cleanup shares one deadline, cancels its child and never dispatches a later input", async () => {
  const started: { args: string[]; at: number; timeoutMs: number }[] = [];
  let active = 0;
  const deadline = Date.now() + 200;
  await expect(closeIphoneTab(async (args, timeoutMs, signal) => {
    expect(active).toBe(0);
    active++;
    started.push({ args, at: Date.now(), timeoutMs });
    try {
      const delay = started.length === 1 ? 10 : 500;
      return await ownedCommand([process.execPath, "-e", `await Bun.sleep(${delay}); console.log('done')`], signal, timeoutMs);
    } finally { active--; }
  }, "owned tab", deadline)).rejects.toThrow();
  const count = started.length;
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(2);
  expect(active).toBe(0);
  expect(started.every(item => item.at < deadline && item.timeoutMs <= deadline - item.at + 1)).toBe(true);
  await Bun.sleep(250);
  expect(started.length).toBe(count);
});

test("transport close is cached and reaps its timed-out native command before any further input", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-close-"));
  const path = "/__goals_iphone/" + "c".repeat(64);
  const log = join(root, "commands.jsonl");
  const agent = join(root, "agent-device");
  await writeFile(agent, `#!${process.execPath}\nimport {appendFile} from 'node:fs/promises';\nawait appendFile(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),pid:process.pid})+'\\n');\nif(process.argv[2]==='press')await Bun.sleep(2000);\n`);
  await chmod(agent, 0o755);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return Response.json(new URL(request.url).pathname.endsWith("/configure") ? "http://127.0.0.1:1234/" : { nonce: "own-tab", timeOrigin: 1, visible: true, userAgent: "iPhone Safari" });
  } });
  const transport = await createIphoneTransport({ control: server.url.origin + path, agent, deviceUDID: "fixture", timeoutMs: 90000 });
  try {
    await transport.navigate("http://127.0.0.1:1234/");
    const started = Date.now();
    const closing = transport.close(true, 150);
    expect(transport.close(true, 150)).toBe(closing);
    await expect(closing).rejects.toThrow("T3 device command failed");
    expect(Date.now() - started).toBeLessThan(1000);
    const rows = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.args[0])).toEqual(["open", "press"]);
    expect(() => process.kill(rows[1].pid, 0)).toThrow();
    await Bun.sleep(200);
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally { await transport.close(true, 150).catch(() => {}); await server.stop(true); await rm(root, { recursive: true, force: true }); }
});
