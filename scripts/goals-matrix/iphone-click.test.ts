import { withScoped } from "./scope-fixture";
import { expect, test } from "bun:test";
import { mkdtemp, chmod, writeFile, readFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded } from "./execute";
import { createIphoneTransport } from "./iphone-transport";
import { IphoneClickTrace } from "./iphone-click";
import { tabBatch, tabOverview } from "./iphone-tab-fixture";
import { object } from "./evidence";
import { Scope } from "./scope";

const arm = { ready: true, before: "0", label: "Increment", url: "http://127.0.0.1:1234/task", timeOrigin: 10, nonce: "task-nonce" };
const good = { trusted: true, sameTarget: true, url: arm.url, timeOrigin: arm.timeOrigin, nonce: arm.nonce, after: "1" };

async function control(observation: Record<string, unknown> | "pending", save?: (text: string) => Promise<void>, arms = [arm], holdSnapshot = false) {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-click-"));
  const agent = join(root, "agent-device");
  const release = Promise.withResolvers<void>();
  const snapshotStarted = Promise.withResolvers<number>();
  const rows: Record<string, unknown>[] = [];
  const sources: string[] = [];
  let arming = 0;
  const commands: string[][] = [];
  const closed = join(root, "closed");
  const beforeTabs = tabBatch(tabOverview(["Goals task-nonce", "fixture owner"]));
  const afterTabs = tabBatch(tabOverview(["fixture owner"]));
  await writeFile(agent, `#!${process.execPath}\nimport{writeFile}from'node:fs/promises';\nconst args=process.argv.slice(2);\nif(args[0]==='batch'){const closing=JSON.parse(args[2])[0].input.target.ref==='@e2';if(closing)await writeFile(${JSON.stringify(closed)},'closed');console.log(closing?${JSON.stringify(afterTabs)}:${JSON.stringify(beforeTabs)});}else console.log('@e1 [button] "Increment"');\n`);
  await chmod(agent, 0o755);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/snapshot") { snapshotStarted.resolve(Number(await request.text())); await release.promise; return new Response(); }
    if (path.endsWith("/configure")) return Response.json(arm.url);
    if (path.endsWith("/state")) return Response.json({ ...arm, visible: true, userAgent: "iPhone Safari", previewFocus: { presentation: "frame-id", presented: true, focused: true } });
    const row = object(await request.json());
    if (typeof row.source !== "string") throw new Error("Missing click expression");
    if (row.source.includes("function presentIphonePreview")) return Response.json({ settled: true, ok: true, value: "frame-id" });
    if (row.source.includes("function iphonePreviewLoad")) return Response.json({ settled: true, ok: true, value: { loaded: true, readyState: "complete" } });
    sources.push(row.source);
    if (row.source.includes("function armIphoneClick")) return Response.json({ settled: true, ok: true, value: arms[Math.min(arming++, arms.length - 1)] });
    if (observation === "pending") await release.promise;
    return Response.json({ settled: true, ok: true, value: observation === "pending" ? good : observation });
  } });
  if (holdSnapshot) await writeFile(agent, `#!${process.execPath}\nif(process.argv[2]==='snapshot')await fetch(${JSON.stringify(server.url.origin + "/snapshot")},{method:'POST',body:String(process.pid)});console.log('@e1 [button] "Increment"');\n`);
  const transport = await createIphoneTransport({ control: server.url.origin + "/__goals_iphone/" + "a".repeat(64), agent, deviceUDID: "fixture", timeoutMs: 1000,
    saveNative: save ?? (async text => { const row = JSON.parse(text); if (row.command) commands.push(row.command.slice(1)); else rows.push(row); }),
  });
  // Native input is only accepted for a preview that opened: loaded, then focused.
  await withScoped(transport, page => page.openPreview(arm.url));
  return { transport, rows, sources, commands, closed, snapshotStarted: snapshotStarted.promise, async close() {
    release.resolve();
    try { await transport.close(); }
    finally { await server.stop(true); await rm(root, { recursive: true, force: true }); }
  } };
}

test("snapshot in flight at scope cancellation remains owned and is reaped without a later press", async () => {
  const fixture = await control(good, undefined, [arm], true);
  const scope = Scope.open(1000);
  try {
    const clicking = fixture.transport.nativeClick!("button", "output", scope);
    const pid = await fixture.snapshotStarted;
    scope.close(new Error("click phase ended"));
    await expect(clicking).rejects.toThrow("click phase ended");
    await expect(fixture.transport.close()).rejects.toThrow("T3 device command failed");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(fixture.commands).toEqual([["snapshot", "-i"]]);
  } finally { scope.close(); await fixture.close().catch(() => {}); }
});

test("native input waits for hydration before arming and presses exactly once", async () => {
  const fixture = await control(good, undefined, [{ ...arm, ready: false }, arm]);
  try {
    expect(await withScoped(fixture.transport, page => page.nativeClick!("button", "output", 1000))).toMatchObject({ before: "0", after: "1", trusted: true });
    expect(fixture.sources.filter(source => source.includes("function armIphoneClick"))).toHaveLength(2);
    expect(fixture.commands).toEqual([["snapshot", "-i"], ["press", "@e1"]]);
  } finally { await fixture.close(); }
});

test("an unhydrated button consumes the original click deadline without native input", async () => {
  const fixture = await control(good, undefined, [{ ...arm, ready: false }]);
  try {
    await expect(bounded(() => withScoped(fixture.transport, page => page.nativeClick!("button", "output", 100)), 200)).rejects.toThrow();
    expect(fixture.commands).toEqual([]);
    expect(fixture.rows.some(row => row.stage === "armed")).toBe(false);
  } finally { await fixture.close(); }
});

test("click failure evidence survives a shorter outer cancellation with the exact false predicate", async () => {
  const fixture = await control({ ...good, trusted: false });
  try {
    await expect(bounded(() => withScoped(fixture.transport, page => page.nativeClick!("button", "output", 180)), 180)).rejects.toThrow();
    await fixture.transport.close();
    await Bun.sleep(5);
    expect(fixture.rows).toContainEqual(expect.objectContaining({ event: "iphone-click", stage: "armed", expectation: expect.objectContaining({ nonce: arm.nonce, after: "1" }) }));
    expect(fixture.rows).toContainEqual(expect.objectContaining({ stage: "observed", predicates: { trusted: false, sameTarget: true, url: true, timeOrigin: true, nonce: true, after: true } }));
    expect(fixture.rows.at(-1)).toMatchObject({ stage: expect.stringMatching(/^(deadline|failed|cancelled)$/), progress: expect.any(String) });
    expect(fixture.commands).toEqual([["snapshot", "-i"], ["press", "@e1"]]);
  } finally { await fixture.close(); }
});

test("a never-returning observation retains pending progress without inventing a DOM reply", async () => {
  const fixture = await control("pending");
  try {
    await expect(bounded(() => withScoped(fixture.transport, page => page.nativeClick!("button", "output", 180)), 180)).rejects.toThrow();
    await fixture.transport.close();
    await Bun.sleep(5);
    expect(fixture.rows.at(-1)).toMatchObject({ stage: expect.stringMatching(/^(deadline|failed|cancelled)$/), progress: "observation-pending", polls: 1 });
    expect(fixture.rows.some(row => row.stage === "observed")).toBe(false);
    expect(fixture.sources).toHaveLength(2);
  } finally { await fixture.close(); }
});

for (const [predicate, value] of Object.entries({ trusted: false, sameTarget: false, url: "http://unrelated.invalid/private", timeOrigin: 11, nonce: "other-nonce", after: "0" })) {
  test(`only the ${predicate} predicate rejects the click and is retained`, async () => {
    const fixture = await control({ ...good, [predicate]: value });
    try {
      await expect(withScoped(fixture.transport, page => page.nativeClick!("button", "output", 180))).rejects.toThrow();
      await Bun.sleep(5);
      const observed = fixture.rows.find(row => row.stage === "observed");
      expect(observed).toMatchObject({ predicates: { trusted: true, sameTarget: true, url: true, timeOrigin: true, nonce: true, after: true, [predicate]: false } });
      expect(JSON.stringify(fixture.rows)).not.toContain("unrelated.invalid");
      expect(JSON.stringify(fixture.rows)).not.toContain("other-nonce");
    } finally { await fixture.close(); }
  });
}

test("early outer cancellation retains the current pending observer without an extra read", async () => {
  const fixture = await control("pending");
  try {
    await expect(bounded(() => withScoped(fixture.transport, page => page.nativeClick!("button", "output", 1000)), 150)).rejects.toThrow();
    await fixture.transport.close();
    await Bun.sleep(5);
    expect(fixture.rows).toContainEqual(expect.objectContaining({ stage: "cancelled", progress: "observation-pending", polls: 1 }));
    expect(fixture.sources).toHaveLength(2);
  } finally { await fixture.close(); }
});

for (const mode of ["reject", "stall"] as const) {
  test(`a ${mode}ing evidence writer cannot change the click or block native teardown`, async () => {
    const fixture = await control(good, () => mode === "reject" ? Promise.reject(new Error("log write failed")) : new Promise(() => {}));
    try {
      await withScoped(fixture.transport, page => page.navigate(arm.url));
      expect(await bounded(() => withScoped(fixture.transport, page => page.nativeClick!("button", "output", 1000)), 1000)).toMatchObject({ before: "0", after: "1", trusted: true });
      expect(await bounded(() => fixture.transport.cleanup!(1000), 1000)).toMatchObject({ browserClosed: true });
      expect(await readFile(fixture.closed, "utf8")).toBe("closed");
    } finally { await fixture.close(); }
  });
}

test("changing observations are capped but the final predicate snapshot stays current", async () => {
  const rows: Record<string, unknown>[] = [];
  const signal = new AbortController();
  const trace = new IphoneClickTrace(async text => { rows.push(JSON.parse(text)); }, 1000, signal.signal);
  try {
    for (let index = 0; index < 1000; index++) {
      trace.observing();
      trace.observed({ trusted: index % 2 === 1, sameTarget: true, url: true, timeOrigin: true, nonce: true, after: false });
    }
    signal.abort();
    trace.observing();
    await Bun.sleep(5);
    expect(rows.filter(row => row.stage === "observed")).toHaveLength(12);
    expect(rows.at(-1)).toMatchObject({ stage: "cancelled", polls: 1000, predicates: { trusted: true, after: false } });
    expect(rows).toHaveLength(15);
  } finally { trace.finish("failed"); }
});

test("the existing append-only native evidence hook persists failure records before teardown", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-click-log-"));
  const log = join(root, "task.native.jsonl");
  const writes: Promise<void>[] = [];
  const ended = Promise.withResolvers<void>();
  const fixture = await control({ ...good, after: "0" }, text => {
    const write = appendFile(log, text);
    writes.push(write);
    return write.then(() => {
      const row: unknown = JSON.parse(text);
      if (row && typeof row === "object" && "stage" in row && (row.stage === "deadline" || row.stage === "failed")) ended.resolve();
    });
  });
  try {
    await expect(bounded(() => withScoped(fixture.transport, page => page.nativeClick!("button", "output", 180)), 180)).rejects.toThrow();
    await bounded(() => ended.promise, 1000);
    await Promise.all(writes);
    const saved = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(saved).toContainEqual(expect.objectContaining({ stage: "observed", predicates: expect.objectContaining({ after: false }) }));
    expect(saved).toContainEqual(expect.objectContaining({ stage: expect.stringMatching(/^(deadline|failed)$/), polls: expect.any(Number) }));
    expect(saved.filter(row => row.event === "iphone-click").every(row => typeof row.clickId === "string")).toBe(true);
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("the diagnostic deadline snapshots only retained progress and stops later logging", async () => {
  const rows: Record<string, unknown>[] = [];
  const trace = new IphoneClickTrace(async text => { rows.push(JSON.parse(text)); }, 20, new AbortController().signal);
  try {
    trace.observing();
    await Bun.sleep(40);
    expect(rows.at(-1)).toMatchObject({ stage: "deadline", progress: "observation-pending", polls: 1 });
    trace.observing();
    trace.armed(arm, "1");
    trace.observed({ trusted: true, sameTarget: true, url: true, timeOrigin: true, nonce: true, after: true });
    await Bun.sleep(5);
    expect(rows).toHaveLength(3);
  } finally { trace.finish("failed"); }
});
