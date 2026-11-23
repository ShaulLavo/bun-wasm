import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { brotliQuality, sha256, sortedBuilds, stageGuestWasm } from "./stage-guest-wasm";
import { settleAll } from "./stage-wasm-sidecars";

// A valid module with a 64 KiB custom section, so the twins are real compressed streams.
const guest = new Uint8Array(Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 0x80, 0x80, 0x04]), Buffer.alloc(64 * 1024, 7)]));
const roots: string[] = [];
const saved = { quality: process.env.BUN_WASM_BROTLI_QUALITY, cache: process.env.BUN_WASM_COMPRESSION_CACHE };

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(process.env.BUN_WASM_TEST_TMP ?? tmpdir(), "bun-wasm-stage-guest-"));
  roots.push(root);
  return root;
}

function restore(name: "BUN_WASM_BROTLI_QUALITY" | "BUN_WASM_COMPRESSION_CACHE", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  restore("BUN_WASM_BROTLI_QUALITY", saved.quality);
  restore("BUN_WASM_COMPRESSION_CACHE", saved.cache);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("a staged guest ships Brotli and gzip twins of its exact bytes and no raw file", async () => {
  const root = await scratch();
  await writeFile(join(root, "source.wasm"), guest);
  const builds: Record<string, string> = {};
  await stageGuestWasm(join(root, "source.wasm"), "bun-browser.wasm", join(root, "out"), builds);
  expect(builds).toEqual({ "bun-browser.wasm": sha256(guest) });
  expect((await readdir(join(root, "out"))).sort()).toEqual(["bun-browser.wasm.br", "bun-browser.wasm.gz"]);
  expect(new Uint8Array(brotliDecompressSync(await readFile(join(root, "out/bun-browser.wasm.br"))))).toEqual(guest);
  expect(new Uint8Array(gunzipSync(await readFile(join(root, "out/bun-browser.wasm.gz"))))).toEqual(guest);
});

test("Brotli quality defaults to the quick setting and accepts only Brotli's own range", () => {
  expect(brotliQuality({})).toBe(5);
  for (const blank of ["", " ", "\t\n"]) expect(brotliQuality({ BUN_WASM_BROTLI_QUALITY: blank })).toBe(5);
  expect(brotliQuality({ BUN_WASM_BROTLI_QUALITY: "11" })).toBe(11);
  expect(brotliQuality({ BUN_WASM_BROTLI_QUALITY: " 9 " })).toBe(9);
  expect(brotliQuality({ BUN_WASM_BROTLI_QUALITY: "0" })).toBe(0);
  for (const value of ["12", "-1", "5.5", "max", "1e1", "0x5", "+5"]) expect(() => brotliQuality({ BUN_WASM_BROTLI_QUALITY: value })).toThrow("BUN_WASM_BROTLI_QUALITY");
});

test("an invalid quality fails before any twin or digest is written", async () => {
  const root = await scratch();
  await writeFile(join(root, "source.wasm"), guest);
  process.env.BUN_WASM_BROTLI_QUALITY = "12";
  const builds: Record<string, string> = {};
  await expect(stageGuestWasm(join(root, "source.wasm"), "bun.wasm", join(root, "out"), builds)).rejects.toThrow("BUN_WASM_BROTLI_QUALITY");
  expect(builds).toEqual({});
  expect(existsSync(join(root, "out"))).toBe(false);
});

for (const failing of [".gz", ".br"]) test(`a failed ${failing} write leaves no twin, temporary file or digest behind`, async () => {
  const root = await scratch();
  const out = join(root, "out");
  await writeFile(join(root, "source.wasm"), guest);
  const builds: Record<string, string> = {};
  const started: string[] = [];
  const write = async (path: string, bytes: Uint8Array) => {
    started.push(path);
    if (path.includes(`bun.wasm${failing}.`)) throw new Error(`disk full at ${failing}`);
    // The other writer finishes later, so cleanup must wait for it.
    await Bun.sleep(20);
    await writeFile(path, bytes);
  };
  await expect(stageGuestWasm(join(root, "source.wasm"), "bun.wasm", out, builds, write)).rejects.toThrow(`disk full at ${failing}`);
  expect(started).toHaveLength(2);
  expect(builds).toEqual({});
  expect(await readdir(out)).toEqual([]);
});

test("a failed guest in a concurrent batch is reported only after the other writers settled", async () => {
  const root = await scratch();
  const out = join(root, "out");
  await writeFile(join(root, "source.wasm"), guest);
  const builds: Record<string, string> = {};
  let finished = false;
  const slow = async (path: string, bytes: Uint8Array) => { await Bun.sleep(50); await writeFile(path, bytes); finished = true; };
  const failing = async () => { throw new Error("staging failed"); };
  await expect(settleAll([
    stageGuestWasm(join(root, "source.wasm"), "bun.wasm", out, builds, slow),
    stageGuestWasm(join(root, "source.wasm"), "quickjs.wasm", out, builds, failing),
  ])).rejects.toThrow("staging failed");
  expect(finished).toBe(true);
  expect(builds).toEqual({ "bun.wasm": sha256(guest) });
  expect((await readdir(out)).sort()).toEqual(["bun.wasm.br", "bun.wasm.gz"]);
});

test("the compression cache reuses a twin by input digest and quality and leaves no temporary files", async () => {
  const root = await scratch();
  const cache = join(root, "cache");
  process.env.BUN_WASM_COMPRESSION_CACHE = cache;
  process.env.BUN_WASM_BROTLI_QUALITY = "4";
  await writeFile(join(root, "source.wasm"), guest);
  await stageGuestWasm(join(root, "source.wasm"), "bun.wasm", join(root, "first"), {});
  const entry = join(cache, `${sha256(guest)}.q4.br`);
  expect(await readdir(cache)).toEqual([`${sha256(guest)}.q4.br`]);
  expect(await readFile(entry)).toEqual(await readFile(join(root, "first/bun.wasm.br")));
  // A marked entry proves the second build reads the cache instead of compressing again.
  await writeFile(entry, "cached twin");
  await stageGuestWasm(join(root, "source.wasm"), "bun.wasm", join(root, "second"), {});
  expect(await readFile(join(root, "second/bun.wasm.br"), "utf8")).toBe("cached twin");
  // Another quality is another entry.
  process.env.BUN_WASM_BROTLI_QUALITY = "3";
  await stageGuestWasm(join(root, "source.wasm"), "bun.wasm", join(root, "third"), {});
  expect(new Uint8Array(brotliDecompressSync(await readFile(join(root, "third/bun.wasm.br"))))).toEqual(guest);
  expect((await readdir(cache)).sort()).toEqual([`${sha256(guest)}.q3.br`, `${sha256(guest)}.q4.br`]);
});

test("concurrently recorded builds serialize in a stable order", () => {
  expect(JSON.stringify(sortedBuilds({ "quickjs.wasm": "b", "bun.wasm": "a", "profiles/shared-group/bun.wasm": "c" })))
    .toBe('{"bun.wasm":"a","profiles/shared-group/bun.wasm":"c","quickjs.wasm":"b"}');
});
