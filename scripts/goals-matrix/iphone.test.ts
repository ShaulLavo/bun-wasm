import { test, expect } from "bun:test";
import { IphoneBus } from "./iphone-bus";
import { nativeButtonRef, validateIphoneControl } from "./iphone-transport";
import { checkClick } from "./playground";
import { withPlayground } from "./test-fixture";
import { frameworks } from "./catalog";
import { closeIphoneTab } from "./iphone-cleanup";
import { ownedCommand } from "./lifetime";

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
