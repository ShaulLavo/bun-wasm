import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairedEngines, programProfile } from "../../src/engine-kind";
import { ENGINES, isEngine } from "../../web/src/engine-loader";
import { prerequisites } from "./discovery";
import { preflight, withStagedAssets } from "./preparation";
import { ready } from "./playground";
import type { Transport } from "./transport";

const profile = programProfile("spidermonkey");
const pair = [profile.core, profile.side];
const data = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

async function site(check: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-engine-"));
  try {
    await Bun.write(join(root, "hono.json"), "{}");
    await check(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function stagePair(root: string): Promise<void> {
  const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  const fingerprints = Object.fromEntries(pair.map(name => [name, hash]));
  await Bun.write(join(root, "index.html"), `<script>globalThis.__bunwasmBuilds=${JSON.stringify(fingerprints)};</script>`);
  await Bun.write(join(root, "engine-builds.json"), JSON.stringify(fingerprints));
  for (const name of pair) await Bun.write(join(root, name + ".gz"), Bun.gzipSync(data));
}
const box = { framework: "hono", browser: "chrome", engine: "spidermonkey" } as const;

test("discovery admits the registered SpiderMonkey loader only with both real profile asset names", () => site(async root => {
  expect(isEngine(box.engine)).toBe(true);
  expect(ENGINES.spidermonkey.wasm).toBe(profile.core);
  expect(prerequisites(box, { root })?.reason).toBe(`Missing engine assets: ${pair.map(name => name + ".gz").join(", ")}`);
  await Bun.write(join(root, profile.core), data);
  expect(prerequisites(box, { root })?.reason).toBe(`Missing engine assets: ${profile.side}.gz`);
  await Bun.write(join(root, profile.side + ".gz"), Bun.gzipSync(data));
  expect(prerequisites(box, { root })).toBeUndefined();
  expect(prerequisites({ ...box, engine: "hermes" }, { root })?.reason).toContain("not registered");
  expect(pairedEngines).toEqual(["quickjs", "jsc"]);
}));

test("SpiderMonkey staging copies its pair and removes the owned staging directory", () => site(async root => {
  await stagePair(root);
  let staged = "";
  await withStagedAssets(root, async directory => {
    staged = directory;
    for (const name of pair) expect(await Bun.file(join(directory, name)).bytes()).toEqual(data);
  });
  expect(await Bun.file(join(staged, profile.core)).exists()).toBe(false);
}));

test("SpiderMonkey preflight rejects stale fingerprints and partial pairs", () => site(async root => {
  await stagePair(root);
  await preflight(root, ["spidermonkey"]);
  await Bun.write(join(root, profile.side + ".gz"), Bun.gzipSync(new Uint8Array([1])));
  await expect(preflight(root, ["spidermonkey"])).rejects.toThrow(`${profile.side} embedded host, manifest, and staged bytes disagree`);
  await rm(join(root, profile.side + ".gz"));
  await expect(preflight(root, ["spidermonkey"])).rejects.toThrow(`Missing engine assets: ${profile.side}`);
}));

function transport(status: string): Transport {
  return {
    capabilities: {}, async navigate() {}, async openPreview() {}, async useHost() {}, async usePreview() {}, async closePreview() {}, async close() {},
    async evaluate<T>(): Promise<T> { return JSON.parse(JSON.stringify({ ready: true, status, engine: box.engine, observedEngine: box.engine, agent: "test" })); },
  };
}
test("ready uses the registered SpiderMonkey status and refuses another engine's label", async () => {
  const status = `${ENGINES.spidermonkey.name} ready`;
  expect(await ready(transport(status), box.engine, 100)).toHaveProperty("status", status);
  await expect(ready(transport(`${ENGINES.jsc.name} ready`), box.engine, 100)).rejects.toThrow("Wrong running engine status");
});
