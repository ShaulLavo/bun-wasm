import { expect, test } from "bun:test";
import { IphoneLane } from "./iphone-lane";
import { Scope } from "./scope";
import type { IphoneSettlement } from "./iphone-bus";
import { createIphoneTransport } from "./iphone-transport";

const success = (value: unknown): IphoneSettlement => ({ settled: true, ok: true, value });

test("idle same-turn calls reserve one send and one waiter, rejecting a third", async () => {
  const lane = new IphoneLane();
  const scope = Scope.open(1000);
  const first = Promise.withResolvers<IphoneSettlement>();
  const calls: number[] = [];
  try {
    const a = lane.execute(() => { calls.push(1); return first.promise; }, scope);
    const b = lane.execute(() => { calls.push(2); return Promise.resolve(success(2)); }, scope);
    const c = lane.execute(() => { calls.push(3); return Promise.resolve(success(3)); }, scope);
    await expect(c).rejects.toThrow("reserved waiter");
    expect(calls).toEqual([1]);
    first.resolve(success(1));
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(calls).toEqual([1, 2]);
  } finally { first.resolve(success(1)); scope.close(); }
});

test("a reserved waiter keeps its turn when a new caller arrives at settlement", async () => {
  const lane = new IphoneLane();
  const scope = Scope.open(1000);
  const first = Promise.withResolvers<IphoneSettlement>();
  const calls: string[] = [];
  try {
    const a = lane.execute(() => first.promise, scope);
    const b = lane.execute(() => { calls.push("reserved"); return Promise.resolve(success(2)); }, scope);
    const newcomer = first.promise.then(() => lane.execute(() => { calls.push("newcomer"); return Promise.resolve(success(3)); }, scope));
    first.resolve(success(1));
    await expect(newcomer).rejects.toThrow("reserved waiter");
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(calls).toEqual(["reserved"]);
  } finally { first.resolve(success(1)); scope.close(); }
});

test("an expired waiter is withdrawn and a later caller can reserve its place", async () => {
  const lane = new IphoneLane();
  const scope = Scope.open(1000), short = Scope.open(5);
  const first = Promise.withResolvers<IphoneSettlement>();
  const calls: string[] = [];
  try {
    const a = lane.execute(() => first.promise, scope);
    await expect(lane.execute(() => { calls.push("expired"); return Promise.resolve(success(2)); }, short)).rejects.toThrow("Phase timed out");
    const b = lane.execute(() => { calls.push("replacement"); return Promise.resolve(success(3)); }, scope);
    first.resolve(success(1));
    expect(await Promise.all([a, b])).toEqual([1, 3]);
    expect(calls).toEqual(["replacement"]);
  } finally { first.resolve(success(1)); short.close(); scope.close(); }
});

test("closing a caller leaves its exact dispatched request owned for natural handoff", async () => {
  const lane = new IphoneLane();
  const phase = Scope.open(1000), observation = Scope.open(1000);
  const first = Promise.withResolvers<IphoneSettlement>();
  let sends = 0;
  try {
    const old = lane.execute(() => first.promise, phase);
    phase.close(new Error("phase ended"));
    await expect(old).rejects.toThrow("phase ended");
    const read = lane.execute(() => { sends++; return Promise.resolve(success("terminal")); }, observation);
    expect(sends).toBe(0);
    first.resolve(success("normal result"));
    expect(await read).toBe("terminal");
    expect(sends).toBe(1);
  } finally { first.resolve(success(null)); phase.close(); observation.close(); }
});

test("known expression errors release the lane; uncertain settlement stays unavailable", async () => {
  const lane = new IphoneLane();
  const scope = Scope.open(1000);
  const reason = new Error("network response lost");
  try {
    await expect(lane.execute(async () => ({ settled: true, ok: false, error: "expression failed" }), scope)).rejects.toThrow("expression failed");
    expect(await lane.execute(async () => success(42), scope)).toBe(42);
    await expect(lane.execute(() => Promise.reject(reason), scope)).rejects.toBe(reason);
    let sent = false;
    await expect(lane.execute(async () => { sent = true; return success(1); }, scope)).rejects.toBe(reason);
    expect(sent).toBe(false);
  } finally { scope.close(); }
});

test.each(["malformed", "unclassified", "after-acceptance"])("transport retains unavailable state after %s response", async mode => {
  const scope = Scope.open(1000);
  const accepted = Promise.withResolvers<void>();
  let sends = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch() {
    sends++;
    if (mode === "malformed") return new Response("invalid JSON");
    if (mode === "unclassified") return Response.json({ error: "command already pending" }, { status: 400 });
    accepted.resolve();
    await new Promise(resolve => scope.signal.addEventListener("abort", resolve, { once: true }));
    return Response.json(success(null));
  } });
  const transport = await createIphoneTransport({ control: server.url.origin + "/__goals_iphone/" + "a".repeat(64), agent: "/unused/agent-device", deviceUDID: "fixture", timeoutMs: 1000 });
  try {
    const result = transport.evaluate("1", scope);
    if (mode === "after-acceptance") { await accepted.promise; await server.stop(true); }
    await expect(result).rejects.toThrow();
    await expect(transport.evaluate("2", scope)).rejects.toThrow();
    expect(sends).toBe(1);
  } finally { scope.close(); await transport.close(); await server.stop(true); }
});

test("a network failure before acceptance is unavailable without a second dispatch", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const control = server.url.origin + "/__goals_iphone/" + "a".repeat(64);
  await server.stop(true);
  const scope = Scope.open(1000);
  const transport = await createIphoneTransport({ control, agent: "/unused/agent-device", deviceUDID: "fixture", timeoutMs: 1000 });
  try {
    const first = await transport.evaluate("1", scope).catch((error: unknown) => error);
    await expect(transport.evaluate("2", scope)).rejects.toBe(first);
  } finally { scope.close(); await transport.close(); }
});
