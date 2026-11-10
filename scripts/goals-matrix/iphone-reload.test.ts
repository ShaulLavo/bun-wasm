import { expect, test } from "bun:test";
import { IphoneBus } from "./iphone-bus";
import { createIphoneTransport } from "./iphone-transport";

const url = "http://127.0.0.1:1234/preview";
const origin = new URL(url).origin;
const endpoint = "http://127.0.0.1:4321";
function attached(role: "host" | "preview" = "preview") {
  const bus = new IphoneBus("/test");
  bus.configure(role, url);
  bus.script(url, endpoint);
  const page = bus.state(role);
  if (!page) throw new Error("Missing configured page");
  const key = { nonce: page.nonce, url, timeOrigin: 1, visible: true };
  bus.poll(role, key, origin);
  return { bus, key };
}
function replacementKey(bus: IphoneBus) {
  const page = bus.state("preview");
  if (!page) throw new Error("Missing replacement preview");
  return { nonce: page.nonce, url, timeOrigin: 2, visible: true };
}

test("preview reload redelivers only the pending observation with its original deadline", async () => {
  const { bus, key } = attached();
  try {
    const pending = bus.execute("preview", "document.title", 1000, true).catch((error: unknown) => error);
    const first = bus.poll("preview", key, origin);
    const script = bus.script(url, endpoint);
    const next = replacementKey(bus);
    expect(script).toContain(next.nonce);
    expect(next.nonce).not.toBe(key.nonce);
    expect(() => bus.reply("preview", { ...key, id: 1, ok: true, value: "stale" }, origin)).toThrow("Wrong");
    expect(bus.poll("preview", next, origin)).toEqual(first);
    bus.reply("preview", { ...next, id: 1, ok: true, value: "current" }, origin);
    expect(await pending).toBe("current");
  } finally { bus.close(); }
});

test("preview reload rejects a pending action instead of replaying it", async () => {
  const { bus, key } = attached();
  try {
    const pending = bus.execute("preview", "button.click()", 1000);
    const rejected = pending.catch((error: unknown) => error);
    expect(bus.poll("preview", key, origin)).not.toBeNull();
    bus.script(url, endpoint);
    expect(await rejected).toMatchObject({ message: "iPhone preview document replaced" });
    expect(bus.poll("preview", replacementKey(bus), origin)).toBeNull();
  } finally { bus.close(); }
});

test("loading preview queues a read but rejects an action before the new document attaches", async () => {
  const { bus } = attached();
  try {
    bus.script(url, endpoint);
    expect(() => bus.execute("preview", "button.click()", 1000)).toThrow("not ready");
    const pending = bus.execute("preview", "document.title", 1000, true);
    const next = replacementKey(bus);
    expect(bus.poll("preview", next, origin)).toMatchObject({ source: "document.title" });
    bus.reply("preview", { ...next, id: 1, ok: true, value: "ready" }, origin);
    expect(await pending).toBe("ready");
  } finally { bus.close(); }
});

test("host replacement and unannounced preview identity changes remain rejected", () => {
  const host = attached("host");
  const preview = attached();
  try {
    expect(() => host.bus.script(url, endpoint)).toThrow("Unexpected");
    expect(() => host.bus.poll("host", { ...host.key, timeOrigin: 2 }, origin)).toThrow("replaced");
    expect(() => preview.bus.poll("preview", { ...preview.key, timeOrigin: 2 }, origin)).toThrow("replaced");
    expect(preview.bus.script(url + "/wrong", endpoint)).toBeUndefined();
    expect(preview.bus.state("preview")?.nonce).toBe(preview.key.nonce);
    preview.bus.script(url, endpoint);
    expect(() => preview.bus.poll("preview", preview.key, origin)).toThrow("Wrong");
    expect(() => preview.bus.poll("preview", { ...replacementKey(preview.bus), url: url + "/wrong" }, origin)).toThrow("Wrong");
  } finally { host.bus.close(); preview.bus.close(); }
});

test("an undelivered replacement observation still expires under its original timer", async () => {
  const { bus, key } = attached();
  try {
    const pending = bus.execute("preview", "document.title", 30, true);
    const rejected = pending.catch((error: unknown) => error);
    bus.poll("preview", key, origin);
    bus.script(url, endpoint);
    expect(await rejected).toMatchObject({ message: "iPhone observer command expired or closed" });
    expect(bus.poll("preview", replacementKey(bus), origin)).toBeNull();
  } finally { bus.close(); }
});

test("repeated preview reloads keep the original command and close cancels its observation", async () => {
  const { bus, key } = attached();
  try {
    const pending = bus.execute("preview", "document.title", 1000, true).catch((error: unknown) => error);
    const first = bus.poll("preview", key, origin);
    bus.script(url, endpoint);
    const second = replacementKey(bus);
    expect(bus.poll("preview", second, origin)).toEqual(first);
    bus.script(url, endpoint);
    const third = replacementKey(bus);
    expect(third.nonce).not.toBe(second.nonce);
    expect(() => bus.poll("preview", second, origin)).toThrow("Wrong");
    expect(bus.poll("preview", third, origin)).toEqual(first);
    bus.close();
    expect(await pending).toMatchObject({ message: "iPhone observer command expired or closed" });
    expect(bus.state("preview")).toBeNull();
  } finally { bus.close(); }
});

test("explicit preview navigation cancels a reload observation rather than moving it to another page", async () => {
  const { bus, key } = attached();
  try {
    const pending = bus.execute("preview", "document.title", 1000, true).catch((error: unknown) => error);
    bus.poll("preview", key, origin);
    bus.script(url, endpoint);
    bus.configure("preview", url + "/other");
    expect(await pending).toMatchObject({ message: "iPhone observer command expired or closed" });
    const next = { ...replacementKey(bus), url: url + "/other" };
    expect(bus.poll("preview", next, origin)).toBeNull();
  } finally { bus.close(); }
});

test("every script gets a new identity even if the previous document never attached", async () => {
  const { bus, key } = attached();
  try {
    const pending = bus.execute("preview", "document.title", 1000, true).catch((error: unknown) => error);
    const first = bus.poll("preview", key, origin);
    bus.script(url, endpoint);
    const attaching = replacementKey(bus);
    bus.script(url, endpoint);
    const current = { ...replacementKey(bus), timeOrigin: 3 };
    expect(current.nonce).not.toBe(attaching.nonce);
    expect(() => bus.poll("preview", attaching, origin)).toThrow("Wrong");
    expect(() => bus.reply("preview", { ...attaching, id: 1, ok: true, value: "stale" }, origin)).toThrow("Wrong");
    expect(bus.poll("preview", current, origin)).toEqual(first);
    bus.reply("preview", { ...current, id: 1, ok: true, value: "current" }, origin);
    expect(await pending).toBe("current");
  } finally { bus.close(); }
});

test("host script replacement is rejected before its first document attaches", () => {
  const bus = new IphoneBus("/test");
  try {
    bus.configure("host", url);
    bus.script(url, endpoint);
    expect(() => bus.script(url, endpoint)).toThrow("Unexpected");
  } finally { bus.close(); }
});

test("transport forwards observation mode without marking ordinary evaluations replayable", async () => {
  const bodies: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.json());
    return Response.json(42);
  } });
  const transport = await createIphoneTransport({ control: server.url.origin + "/__goals_iphone/" + "e".repeat(64), agent: "/bound/agent-device", deviceUDID: "fixture", timeoutMs: 1000 });
  try {
    await transport.usePreview();
    expect(await transport.evaluate("read()", { observation: true })).toBe(42);
    expect(await transport.evaluate("action()")).toBe(42);
    expect(bodies).toEqual([{ source: "read()", timeoutMs: 1000, observation: true }, { source: "action()", timeoutMs: 1000, observation: false }]);
  } finally { await transport.close(); await server.stop(true); }
});

test("controller rejects malformed observation mode before creating a pending command", async () => {
  const { bus } = attached();
  try {
    const response = await bus.handle(new Request(endpoint + "/test/preview/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "1", timeoutMs: 1000, observation: "true" }) }), origin);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Invalid iPhone observation mode") });
  } finally { bus.close(); }
});
