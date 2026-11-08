import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight, withStagedAssets } from "./preparation";

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
