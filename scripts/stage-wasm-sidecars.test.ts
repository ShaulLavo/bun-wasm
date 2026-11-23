import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { writeWasmWithSidecars } from "./stage-wasm-sidecars";

test("program staging writes the raw WASM with smaller Brotli and gzip twins of the same bytes", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-sidecars-"));
  try {
    const bytes = new Uint8Array(256 * 1024);
    bytes.set([0, 97, 115, 109, 1, 0, 0, 0]);
    for (let index = 8; index < bytes.length; index++) bytes[index] = (index * 31) % 7;
    const path = join(directory, "programs/shell-engine.wasm");
    await writeWasmWithSidecars(path, bytes);
    const raw = await Bun.file(path).bytes();
    const br = await Bun.file(`${path}.br`).bytes();
    const gz = await Bun.file(`${path}.gz`).bytes();
    expect(raw).toEqual(bytes);
    expect(new Uint8Array(brotliDecompressSync(br))).toEqual(bytes);
    expect(new Uint8Array(gunzipSync(gz))).toEqual(bytes);
    expect(br.length).toBeLessThan(gz.length);
    expect(gz.length).toBeLessThan(bytes.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed twin write keeps the earlier raw and gzip files and leaves no temporary files", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-sidecars-"));
  try {
    const path = join(directory, "env.wasm");
    await Bun.write(path, "earlier raw");
    await Bun.write(`${path}.gz`, "earlier gzip");
    const failing = async (target: string, bytes: Uint8Array) => {
      if (target.startsWith(`${path}.br.`)) throw new Error("disk full");
      await writeFile(target, bytes);
    };
    await expect(writeWasmWithSidecars(path, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), failing)).rejects.toThrow("disk full");
    expect(await Bun.file(path).text()).toBe("earlier raw");
    expect(await Bun.file(`${path}.gz`).text()).toBe("earlier gzip");
    expect((await readdir(directory)).sort()).toEqual(["env.wasm", "env.wasm.gz"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
