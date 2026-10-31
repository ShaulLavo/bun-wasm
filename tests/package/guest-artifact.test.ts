import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  parseGuestDescriptor, describeGuest, GUEST_CACHE_CONTROL, GUEST_ORIGIN, prepareGuest, verifyGuest, writeGuestDescriptor,
} from "../../scripts/guest-artifact.ts";
import { createR2Publisher, publishGuest, verifyPublicGuest } from "../../scripts/publish-guest.ts";
import type { GuestFile } from "../../scripts/guest-artifact.ts";
import type { GuestPublisher } from "../../scripts/publish-guest.ts";
import { loadBunWasm, programLinkPlan } from "../../src/assets";
import { quickjsPair } from "./quickjs-plan-fixture";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const artifact = prepareGuest({ kind: "single", core: wasm });
const scratchRoot = process.env.TMPDIR ?? tmpdir();
const publicHeaders = {
  "content-type": "application/wasm",
  "content-encoding": "gzip",
  "cache-control": GUEST_CACHE_CONTROL,
  "access-control-allow-origin": "*",
};

function publisher(existing: Uint8Array | null, headers = publicHeaders) {
  const uploads: GuestFile[] = [];
  const calls: string[] = [];
  const store: GuestPublisher = {
    async read(key) { calls.push(`read:${key}`); return existing; },
    async upload(value) { uploads.push(value); },
    async fetch(input, init) {
      expect(input).toBe(artifact.descriptor.core.url);
      expect(new Headers(init?.headers).get("origin")).toBe("https://example.com");
      return new Response(wasm, { headers });
    },
  };
  return { store, uploads, calls };
}

test("raw and gzipped inputs have identical decompressed descriptors and hash keys", () => {
  const rawHash = createHash("sha256").update(wasm).digest("hex");
  expect(artifact.descriptor.core).toEqual({ url: `${GUEST_ORIGIN}/${rawHash}/bun.wasm.gz`, sha256: rawHash, bytes: wasm.length });
  expect(prepareGuest({ kind: "single", core: gzipSync(wasm) }).descriptor).toEqual(artifact.descriptor);
  expect(artifact.files.core.key).toBe(`${rawHash}/bun.wasm.gz`);
  expect(new Uint8Array(gunzipSync(artifact.files.core.gzip))).toEqual(wasm);
  expect(WebAssembly.validate(gunzipSync(artifact.files.core.gzip))).toBe(true);
});

test("invalid modules, broken gzip, and non-origin URLs are rejected", () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([0x1f, 0x8b]), new Uint8Array([0, 97, 115, 109, 2, 0, 0, 0]), Buffer.concat([wasm, new Uint8Array([1, 255])])]) {
    expect(() => prepareGuest({ kind: "single", core: bytes })).toThrow();
  }
  for (const origin of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?query", "https://example.com/#hash"]) {
    expect(() => describeGuest(wasm, origin)).toThrow("plain HTTPS origin");
  }
});

test("integrity checks accept transparent HTTP decoding and reject hash or size mismatch", () => {
  verifyGuest(wasm, artifact.descriptor.core);
  verifyGuest(artifact.files.core.gzip, artifact.descriptor.core);
  expect(() => verifyGuest(wasm, { ...artifact.descriptor.core, bytes: wasm.length + 1 })).toThrow("integrity mismatch");
  expect(() => verifyGuest(wasm, { ...artifact.descriptor.core, sha256: "0".repeat(64) })).toThrow("integrity mismatch");
});

test("first publication uploads, then checks public hash and headers", async () => {
  const { store, uploads, calls } = publisher(null);
  expect(await publishGuest(artifact, store)).toEqual(artifact.descriptor);
  expect(calls).toEqual([`read:${artifact.files.core.key}`]);
  expect(uploads).toEqual([artifact.files.core]);
});

test("publication snapshots caller bytes, key and descriptor before storage callbacks", async () => {
  for (const exists of [false, true]) {
    const original = prepareGuest({ kind: "single", core: wasm });
    const mutableFile = { key: original.files.core.key, gzip: new Uint8Array(original.files.core.gzip), descriptor: { ...original.descriptor.core } };
    const mutable = { files: { kind: "single", core: mutableFile }, descriptor: { kind: "single", core: { ...original.descriptor.core } } } satisfies Parameters<typeof publishGuest>[0];
    const uploads: GuestFile[] = [];
    const store: GuestPublisher = {
      async read(key) {
        expect(key).toBe(original.files.core.key);
        mutableFile.key = "existing-object/bun.wasm.gz";
        mutableFile.gzip.fill(0);
        mutable.descriptor.core.url = "https://example.test/changed.wasm.gz";
        mutable.descriptor.core.sha256 = "0".repeat(64);
        mutable.descriptor.core.bytes++;
        return exists ? original.files.core.gzip : null;
      },
      async upload(value) { uploads.push(value); },
      async fetch(input) {
        expect(input).toBe(original.descriptor.core.url);
        return new Response(wasm, { headers: publicHeaders });
      },
    };
    expect(await publishGuest(mutable, store)).toEqual(original.descriptor);
    expect(uploads).toEqual(exists ? [] : [original.files.core]);
  }
});

test("an existing matching object is idempotent, including different gzip representations", async () => {
  const { store, uploads } = publisher(gzipSync(wasm, { level: 0 }));
  await publishGuest(artifact, store);
  await publishGuest(artifact, store);
  expect(uploads).toHaveLength(0);
});

test("an existing mismatched object is never overwritten", async () => {
  const other = Buffer.concat([wasm, new Uint8Array([0, 1, 0])]);
  const { store, uploads } = publisher(gzipSync(other));
  await expect(publishGuest(artifact, store)).rejects.toThrow("integrity mismatch");
  expect(uploads).toHaveLength(0);
});

test("wrong input or a non-hash key is rejected before reading or uploading", async () => {
  const { store, uploads, calls } = publisher(null);
  await expect(publishGuest({ ...artifact, files: { kind: "single", core: { ...artifact.files.core, gzip: gzipSync(new Uint8Array()) } } }, store)).rejects.toThrow();
  await expect(publishGuest({ ...artifact, files: { kind: "single", core: { ...artifact.files.core, key: "latest/bun.wasm.gz" } } }, store)).rejects.toThrow("key does not match");
  expect(uploads).toHaveLength(0);
  expect(calls).toHaveLength(0);
});

test("publication fails on bad public headers, status, or body even after an upload", async () => {
  for (const header of Object.keys(publicHeaders)) {
    const headers = { ...publicHeaders, [header]: "wrong" };
    const { store } = publisher(null, headers);
    await expect(publishGuest(artifact, store)).rejects.toThrow();
  }
  for (const value of ["public, max-age=31536000", `${GUEST_CACHE_CONTROL}, no-store`]) {
    const { store } = publisher(null, { ...publicHeaders, "cache-control": value });
    await expect(publishGuest(artifact, store)).rejects.toThrow("Cache-Control");
  }
  await expect(verifyPublicGuest(artifact.descriptor.core, async () => new Response(null, { status: 404 }))).rejects.toThrow("HTTP 404");
  await expect(verifyPublicGuest(artifact.descriptor.core, async () => new Response(Buffer.concat([wasm, new Uint8Array([0, 1, 0])]), { headers: publicHeaders }))).rejects.toThrow("integrity mismatch");
  await verifyPublicGuest(artifact.descriptor.core, async () => new Response(Buffer.from(artifact.files.core.gzip), { headers: publicHeaders }));
});

test("CLI emits a paired descriptor for a split core and rejects a missing side", async () => {
  const scratch = await mkdtemp(join(scratchRoot, "bun-wasm-guest-cli-test-"));
  try {
    const { core, side } = quickjsPair();
    const corePath = join(scratch, "bun.wasm");
    const outputPath = join(scratch, "guest-asset.generated.ts");
    await writeFile(corePath, core); await writeFile(join(scratch, "quickjs.wasm"), side);
    const command = [process.execPath, "scripts/guest-artifact.ts", corePath, "--origin", GUEST_ORIGIN, "--output", outputPath];
    const paired = Bun.spawnSync(command, { cwd: process.cwd() });
    expect(paired.exitCode).toBe(0);
    const descriptor = parseGuestDescriptor(JSON.parse(paired.stdout.toString()));
    if (descriptor.kind !== "quickjs") throw new Error("Expected QuickJS descriptor");
    expect(descriptor.side).toEqual({
      url: `${GUEST_ORIGIN}/${createHash("sha256").update(side).digest("hex")}/quickjs.wasm.gz`,
      sha256: createHash("sha256").update(side).digest("hex"), bytes: side.length,
    });
    expect(await readFile(outputPath, "utf8")).toContain('quickjs.wasm.gz');
    const module = await loadBunWasm({ asset: descriptor, fetch: async url => new Response(url === descriptor.core.url ? core : side) });
    expect(programLinkPlan(module)?.libraries[0]?.source).toEqual(side);
    await writeFile(join(scratch, "quickjs.wasm"), Uint8Array.from([0]));
    const invalid = Bun.spawnSync(command, { cwd: process.cwd() });
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr.toString()).toContain("valid WASM");
    await rm(join(scratch, "quickjs.wasm"));
    const missing = Bun.spawnSync(command, { cwd: process.cwd() });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain("quickjs.wasm");
    await writeFile(corePath, wasm);
    const ordinary = Bun.spawnSync(command, { cwd: process.cwd() });
    expect(ordinary.exitCode).toBe(0);
    expect(JSON.parse(ordinary.stdout.toString())).toEqual({ kind: "single", core: describeGuest(wasm) });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("descriptor generator writes a typed constant without bundling guest bytes", async () => {
  const scratch = await mkdtemp(join(scratchRoot, "bun-wasm-guest-descriptor-test-"));
  try {
    const output = join(scratch, "guest-asset.generated.ts");
    await writeGuestDescriptor(output, artifact.descriptor);
    const source = await readFile(output, "utf8");
    expect(source).toContain("import type { BunWasmAsset }");
    expect(source).toContain("/src/assets.js\"");
    expect(source).toContain("export const BUN_WASM_ASSET: BunWasmAsset | null =");
    expect(source).toContain(JSON.stringify(artifact.descriptor, null, 2));
    expect(source.length).toBeLessThan(1000);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("interrupted uploads settle only after Wrangler stops using the upload file", async () => {
  const scratch = await mkdtemp(join(scratchRoot, "bun-wasm-guest-interrupt-test-"));
  const controller = new AbortController();
  let uploading: Promise<void> | undefined;
  try {
    const ready = join(scratch, "ready");
    const stopped = join(scratch, "stopped");
    const childScript = join(scratch, "fake-wrangler.ts");
    await writeFile(childScript, `
      import { writeFileSync, existsSync } from "node:fs";
      process.on("SIGTERM", () => setTimeout(() => {
        if (existsSync(${JSON.stringify(join(scratch, "bun.wasm.gz"))})) {
          writeFileSync(${JSON.stringify(stopped)}, "closed after reading input");
        }
        process.exit(0);
      }, 30));
      setInterval(() => {}, 1000);
      writeFileSync(${JSON.stringify(ready)}, "ready");
    `);
    const store = createR2Publisher({ accountId: "0".repeat(32), token: "test-not-a-credential", bucket: "fixture",
      scratch, wrangler: childScript, signal: controller.signal });
    uploading = store.upload(artifact.files.core);
    // Attach a rejection handler immediately; the test intentionally aborts this promise.
    void uploading.catch(() => {});
    const deadline = Date.now() + 3000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("Fixture child did not become ready");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort();
    await expect(uploading).rejects.toThrow();
    expect(await readFile(stopped, "utf8")).toBe("closed after reading input");
  } finally {
    controller.abort();
    await uploading?.catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});

for (const kind of ["quickjs", "jsc"] as const) test(`${kind} publication verifies and snapshots both files before callbacks`, async () => {
  const { core, side } = quickjsPair(kind);
  const pair = prepareGuest({ kind, core, side });
  if (pair.files.kind === "single" || pair.descriptor.kind === "single") throw new Error("Expected pair");
  const uploads: GuestFile[] = [];
  const reads: string[] = [];
  const sideUrl = pair.descriptor.side.url;
  const store: GuestPublisher = {
    async read(key) { reads.push(key); return null; },
    async upload(value) { uploads.push(value); },
    async fetch(url) { return new Response(url === sideUrl ? side : core, { headers: publicHeaders }); },
  };
  expect(await publishGuest(pair, store)).toEqual(pair.descriptor);
  expect(reads).toEqual([pair.files.side.key, pair.files.core.key]);
  expect(uploads.map(upload => upload.key)).toEqual(reads);
  expect(new Uint8Array(gunzipSync(pair.files.side.gzip))).toEqual(side);
  const corrupted = prepareGuest({ kind, core, side });
  if (corrupted.files.kind === "single") throw new Error("Expected pair");
  corrupted.files.side.gzip.fill(0);
  await expect(publishGuest(corrupted, store)).rejects.toThrow();
  const mismatched = { ...pair, descriptor: { ...pair.descriptor, side: { ...pair.descriptor.side, sha256: "0".repeat(64) } } };
  await expect(publishGuest(mismatched, store)).rejects.toThrow("paired engine identity");
  expect(reads).toHaveLength(2);
});
