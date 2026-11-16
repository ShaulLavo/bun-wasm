import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIphoneTransport } from "./iphone-transport";
import { Scope } from "./scope";
import { prepareIphoneSafari } from "./iphone-setup";
import { tabBatch } from "./iphone-tab-fixture";
import { batchSnapshot } from "./iphone-tab-snapshot";
import privateOverview from "./fixtures/iphone-private-overview.json";
import axOverview from "./fixtures/iphone-group-ax.json";
import selectedOverview from "./fixtures/iphone-group-selected.json";

type Snapshot = { appBundleId: string; truncated: boolean; nodes: Record<string, unknown>[] };
const ordinaryOverview = (): Snapshot => ({ ...privateOverview, nodes: privateOverview.nodes.map(node => ({ ...node,
  selected: node.label === "23 Tabs, Tab Group" && node.kind === "button",
})) });

test("the captured Private overview still fails the strict cleanup tab-count guard", () => {
  expect(() => batchSnapshot(tabBatch(privateOverview), ["press", "snapshot"])).toThrow("Cannot identify Safari tab count");
});

async function fixture(initial: Snapshot, selected = ordinaryOverview()) {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-iphone-setup-"));
  const agent = join(root, "agent-device"), log = join(root, "commands.jsonl"), switched = join(root, "ordinary");
  let configured = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname.endsWith("/configure")) { configured++; return Response.json("http://fixture/task"); }
    return Response.json({ nonce: "owned", timeOrigin: 1, visible: true, userAgent: "iPhone Safari" });
  } });
  const close = async () => { await server.stop(true); await rm(root, { recursive: true, force: true }); };
  try {
    await writeFile(agent, `#!${process.execPath}
import {appendFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
const args=process.argv.slice(2);
await appendFile(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='batch') {
  const steps=JSON.parse(args[2]);
  if(steps.some(step=>step.input.target?.ref==='@e18'||step.input.target?.ref==='@e15')) await writeFile(${JSON.stringify(switched)},'selected');
  const snapshot=existsSync(${JSON.stringify(switched)})?${JSON.stringify(selected)}:${JSON.stringify(initial)};
  console.log(JSON.stringify({success:true,data:{total:steps.length,executed:steps.length,results:steps.map((step,index)=>({step:index+1,command:step.command,ok:true,data:step.command==='snapshot'?snapshot:{}}))}}));
}
`);
    await chmod(agent, 0o700);
    const transport = await createIphoneTransport({ control: server.url.origin + "/__goals_iphone/" + "a".repeat(64), agent, deviceUDID: "fixture", timeoutMs: 5000 });
    return { transport, configured: () => configured, commands: async (): Promise<string[][]> => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), close };
  } catch (error) { await close(); throw error; }
}

test("Safari selects the ordinary group from captured Private AX before owned navigation", async () => {
  const f = await fixture(privateOverview);
  const scope = Scope.open(10_000);
  try {
    await f.transport.navigate("http://fixture/task", scope);
    const commands = await f.commands();
    const selection = commands.findIndex(args => args[0] === "batch" && args[2]?.includes('"ref":"@e18"'));
    const navigation = commands.findIndex(args => args[0] === "open" && args[2] === "http://fixture/task");
    expect(selection).toBeGreaterThan(-1);
    expect(navigation).toBeGreaterThan(selection);
    expect(commands[0]).toEqual(["open", "com.apple.mobilesafari"]);
    expect(JSON.stringify(commands)).not.toContain("Close");
    expect(JSON.stringify(commands)).not.toMatch(/@e(?:5|6|7|8|17)\b/);
  } finally { scope.close(); await f.close(); }
});

test("an already selected ordinary group needs no group press", async () => {
  const f = await fixture(ordinaryOverview());
  const scope = Scope.open(10_000);
  try {
    await f.transport.navigate("http://fixture/task", scope);
    expect((await f.commands()).map(args => args[0])).toEqual(["open", "batch", "open"]);
  } finally { scope.close(); await f.close(); }
});

test("captured AX duplicate wrappers locate one physical ordinary target and require selected tree proof", async () => {
  const f = await fixture(axOverview, selectedOverview);
  const scope = Scope.open(10_000);
  try {
    await f.transport.navigate("http://fixture/task", scope);
    const commands = await f.commands();
    expect(commands.map(args => args[0])).toEqual(["open", "batch", "batch", "open"]);
    expect(commands[2]?.[2]).toContain('"ref":"@e15"');
    expect(commands[2]?.[2]).toContain('"settle":true');
    expect(JSON.stringify(commands)).not.toContain("Close");
    expect(JSON.stringify(commands)).not.toMatch(/@e(?:5|6|13|17)\b/);
  } finally { scope.close(); await f.close(); }
});

test.each(["different-bounds", "different-label", "different-strip", "missing-target", "no-selected-proof"])("AX %s cannot start owned navigation", async scenario => {
  const initial = structuredClone(axOverview);
  const duplicate = initial.nodes.find(node => node.ref === "e19")!;
  if (scenario === "different-bounds") duplicate.rect.x++;
  if (scenario === "different-label") duplicate.label = "24 Tabs";
  if (scenario === "different-strip") {
    initial.nodes.push({ ...initial.nodes[0]!, index: 91 });
    initial.nodes.find(node => node.ref === "e18")!.parentIndex = 91;
  }
  if (scenario === "missing-target") initial.nodes = initial.nodes.filter(node => node.label !== "23 Tabs");
  const f = await fixture(initial, scenario === "no-selected-proof" ? axOverview : selectedOverview);
  const scope = Scope.open(10_000);
  try {
    await expect(f.transport.navigate("http://fixture/task", scope)).rejects.toThrow();
    expect(f.configured()).toBe(0);
    expect((await f.commands()).some(args => args[0] === "open" && args.length > 2)).toBe(false);
  } finally { scope.close(); await f.close(); }
});

test.each(["missing", "ambiguous", "unselected", "truncated", "foreign"])("%s ordinary setup refuses owned navigation", async scenario => {
  const initial = structuredClone(privateOverview);
  if (scenario === "missing") initial.nodes = initial.nodes.filter(node => node.label !== "23 Tabs, Tab Group");
  if (scenario === "ambiguous") initial.nodes.push({ ...initial.nodes.find(node => node.ref === "e18")!, ref: "e90" });
  if (scenario === "truncated") initial.truncated = true;
  if (scenario === "foreign") initial.appBundleId = "other";
  const f = await fixture(initial, scenario === "unselected" ? privateOverview : ordinaryOverview());
  const scope = Scope.open(10_000);
  try {
    await expect(f.transport.navigate("http://fixture/task", scope)).rejects.toThrow();
    expect(f.configured()).toBe(0);
    expect((await f.commands()).some(args => args[0] === "open" && args.length > 2)).toBe(false);
    expect(JSON.stringify(await f.commands())).not.toContain("Close");
  } finally { scope.close(); await f.close(); }
});

test("cancelled setup dispatches no native or owned navigation", async () => {
  const f = await fixture(privateOverview);
  const scope = Scope.open(10_000);
  scope.close(new Error("setup cancelled"));
  try {
    await expect(f.transport.navigate("http://fixture/task", scope)).rejects.toThrow("setup cancelled");
    expect(await f.commands()).toEqual([]);
    expect(f.configured()).toBe(0);
  } finally { await f.close(); }
});

test("setup opens the overview from an existing page and settles both transitions", async () => {
  const commands: string[][] = [];
  const page = { ...privateOverview, nodes: [{ kind: "button", label: "More", index: 1, ref: "e2" }] };
  const snapshots = [page, privateOverview, ordinaryOverview()];
  const scope = Scope.open(10_000);
  try {
    await prepareIphoneSafari(async args => {
      commands.push(args);
      if (args[0] !== "batch") return "Opened";
      const steps: { command: string; input: { settle?: boolean } }[] = JSON.parse(args[2]!);
      expect(steps.filter(step => step.command === "press").every(step => step.input.settle === true)).toBe(true);
      return tabBatch(snapshots.shift(), steps.map(step => step.command));
    }, scope);
    expect(commands).toHaveLength(4);
    expect(commands[2]?.[2]).toContain('label=\\"All Tabs\\"');
    expect(JSON.stringify(commands)).not.toContain("Close");
    expect(snapshots).toHaveLength(0);
  } finally { scope.close(); }
});

test.each(["cancelled", "expired", "command-failed", "partial-batch"])("%s setup never presses a group after an unsettled read", async scenario => {
  const scope = Scope.open(10_000);
  const commands: string[][] = [];
  const expired = { signal: scope.signal, deadline: Date.now() - 1, expiryReason: new Error("setup expired") };
  try {
    await expect(prepareIphoneSafari(async (args, timeoutMs, signal) => {
      expect(signal).toBe(scope.signal);
      expect(timeoutMs).toBeGreaterThan(0);
      commands.push(args);
      if (args[0] !== "batch") return "Opened";
      if (scenario === "command-failed") throw new Error("native command failed");
      if (scenario === "cancelled") scope.close(new Error("setup cancelled"));
      return scenario === "partial-batch" ? JSON.stringify({ success: false }) : tabBatch(privateOverview, ["snapshot"]);
    }, scenario === "expired" ? expired : scope)).rejects.toThrow();
    expect(commands.map(args => args[0])).toEqual(scenario === "expired" ? [] : ["open", "batch"]);
  } finally { scope.close(); }
});
