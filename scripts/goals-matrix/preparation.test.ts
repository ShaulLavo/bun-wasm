import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight, preparationOptions, withStagedAssets } from "./preparation";
import { engineFiles } from "./engines";

test("copying assets after a build with an empty embedded map fails before framework attempts", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-preflight-"));
  try {
    const data = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    await Bun.write(join(scratch, "index.html"), "<script>globalThis.__bunwasmBuilds={};</script>");
    await Bun.write(join(scratch, "engine-builds.json"), JSON.stringify({ "bun.wasm": hash, "quickjs.wasm": hash }));
    for (const name of ["bun.wasm", "quickjs.wasm"]) await Bun.write(join(scratch, name + ".gz"), Bun.gzipSync(data));
    await expect(preflight(scratch, ["quickjs"])).rejects.toThrow("Preparation error");
    await withStagedAssets(scratch, async staged => {
      expect(await Bun.file(join(staged, "quickjs.wasm")).bytes()).toEqual(data);
      const map = { "bun.wasm": hash, "quickjs.wasm": hash };
      await Bun.write(join(scratch, "index.html"), `<script>globalThis.__bunwasmBuilds=${JSON.stringify(map)};</script>`);
      await preflight(scratch, ["quickjs"]);
    });
    await Bun.write(join(scratch, "quickjs.wasm.gz"), Bun.gzipSync(new Uint8Array([1])));
    await expect(preflight(scratch, ["quickjs"])).rejects.toThrow("Preparation error");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("preparation accepts a separate SpiderMonkey pair with its source record", () => {
  const options = preparationOptions(["/delivery", "--spidermonkey=/ordinary/pair", "--spidermonkey-source=/ordinary/components.json"]);
  expect(options).toEqual({ delivery: "/delivery", spidermonkey: { directory: "/ordinary/pair", source: "/ordinary/components.json" } });
  expect(preparationOptions(["/delivery"])).toEqual({ delivery: "/delivery", spidermonkey: undefined });
  for (const flags of [["--spidermonkey=/pair"], ["--spidermonkey-source=/source.json"], ["--unknown=x"], ["--spidermonkey=/a", "--spidermonkey=/b"]]) {
    expect(() => preparationOptions(["/delivery"].concat(flags))).toThrow();
  }
});

async function checkOverlay(directory: string, original: Uint8Array<ArrayBuffer>, replacement: Uint8Array<ArrayBuffer>): Promise<void> {
  for (const name of engineFiles("spidermonkey")) expect(await Bun.file(join(directory, name)).bytes()).toEqual(replacement);
  for (const name of engineFiles("quickjs")) expect(await Bun.file(join(directory, name)).bytes()).toEqual(original);
}

test("an explicit ordinary pair replaces only SpiderMonkey and cannot fall back to delivery bytes", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-overlay-"));
  const delivery = join(scratch, "delivery"), pair = join(scratch, "pair");
  const original = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const replacement = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 1, 0]);
  const names = engineFiles("spidermonkey");
  let staged = "";
  try {
    for (const name of engineFiles("quickjs").concat(names)) await Bun.write(join(delivery, name + ".gz"), Bun.gzipSync(original));
    await expect(withStagedAssets(delivery, async () => { throw new Error("build must not start"); }, { spidermonkey: pair })).rejects.toThrow("Missing engine assets");
    await Bun.write(join(pair, "bun-spidermonkey.wasm"), replacement);
    await expect(withStagedAssets(delivery, async () => { throw new Error("build must not start"); }, { spidermonkey: pair })).rejects.toThrow("Missing engine assets: spidermonkey-engine.wasm");
    await Bun.write(join(pair, "spidermonkey-engine.wasm.gz"), Bun.gzipSync(replacement));
    await withStagedAssets(delivery, async directory => {
      staged = directory;
      await checkOverlay(directory, original, replacement);
    }, { spidermonkey: pair });
    expect(await Bun.file(join(staged, "bun-spidermonkey.wasm")).exists()).toBe(false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
