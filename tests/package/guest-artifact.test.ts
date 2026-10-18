import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  describeGuest, GUEST_CACHE_CONTROL, GUEST_ORIGIN, prepareGuest, verifyGuest, writeGuestDescriptor,
} from "../../scripts/guest-artifact.ts";
import { createR2Publisher, publishGuest, verifyPublicGuest } from "../../scripts/publish-guest.ts";
import type { GuestArtifact } from "../../scripts/guest-artifact.ts";
import type { GuestPublisher } from "../../scripts/publish-guest.ts";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const artifact = prepareGuest(wasm);
const scratchRoot = process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
const publicHeaders = {
  "content-type": "application/wasm",
  "content-encoding": "gzip",
  "cache-control": GUEST_CACHE_CONTROL,
  "access-control-allow-origin": "*",
};

function publisher(existing: Uint8Array | null, headers = publicHeaders) {
  const uploads: GuestArtifact[] = [];
  const calls: string[] = [];
  const store: GuestPublisher = {
    async read(key) { calls.push(`read:${key}`); return existing; },
    async upload(value) { uploads.push(value); },
    async fetch(input, init) {
      expect(input).toBe(artifact.descriptor.url);
      expect(new Headers(init?.headers).get("origin")).toBe("https://example.com");
      return new Response(wasm, { headers });
    },
  };
  return { store, uploads, calls };
}

test("raw and gzipped inputs have identical decompressed descriptors and hash keys", () => {
  const rawHash = createHash("sha256").update(wasm).digest("hex");
  expect(artifact.descriptor).toEqual({ url: `${GUEST_ORIGIN}/${rawHash}/bun.wasm.gz`, sha256: rawHash, bytes: wasm.length });
  expect(prepareGuest(gzipSync(wasm)).descriptor).toEqual(artifact.descriptor);
  expect(artifact.key).toBe(`${rawHash}/bun.wasm.gz`);
  expect(new Uint8Array(gunzipSync(artifact.gzip))).toEqual(wasm);
  expect(WebAssembly.validate(gunzipSync(artifact.gzip))).toBe(true);
});

test("invalid modules, broken gzip, and non-origin URLs are rejected", () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([0x1f, 0x8b]), new Uint8Array([0, 97, 115, 109, 2, 0, 0, 0]), Buffer.concat([wasm, new Uint8Array([1, 255])])]) {
    expect(() => prepareGuest(bytes)).toThrow();
  }
  for (const origin of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?query", "https://example.com/#hash"]) {
    expect(() => describeGuest(wasm, origin)).toThrow("plain HTTPS origin");
  }
});

test("integrity checks accept transparent HTTP decoding and reject hash or size mismatch", () => {
  verifyGuest(wasm, artifact.descriptor);
  verifyGuest(artifact.gzip, artifact.descriptor);
  expect(() => verifyGuest(wasm, { ...artifact.descriptor, bytes: wasm.length + 1 })).toThrow("integrity mismatch");
  expect(() => verifyGuest(wasm, { ...artifact.descriptor, sha256: "0".repeat(64) })).toThrow("integrity mismatch");
});

test("first publication uploads, then checks public hash and headers", async () => {
  const { store, uploads, calls } = publisher(null);
  expect(await publishGuest(artifact, store)).toEqual(artifact.descriptor);
  expect(calls).toEqual([`read:${artifact.key}`]);
  expect(uploads).toEqual([artifact]);
});

test("publication snapshots caller bytes, key and descriptor before storage callbacks", async () => {
  for (const exists of [false, true]) {
    const original = prepareGuest(wasm);
    const mutable = { key: original.key, gzip: new Uint8Array(original.gzip), descriptor: { ...original.descriptor } };
    const uploads: GuestArtifact[] = [];
    const store: GuestPublisher = {
      async read(key) {
        expect(key).toBe(original.key);
        mutable.key = "existing-object/bun.wasm.gz";
        mutable.gzip.fill(0);
        mutable.descriptor.url = "https://example.test/changed.wasm.gz";
        mutable.descriptor.sha256 = "0".repeat(64);
        mutable.descriptor.bytes++;
        return exists ? original.gzip : null;
      },
      async upload(value) { uploads.push(value); },
      async fetch(input) {
        expect(input).toBe(original.descriptor.url);
        return new Response(wasm, { headers: publicHeaders });
      },
    };
    expect(await publishGuest(mutable, store)).toEqual(original.descriptor);
    expect(uploads).toEqual(exists ? [] : [original]);
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
  await expect(publishGuest({ ...artifact, gzip: gzipSync(new Uint8Array()) }, store)).rejects.toThrow();
  await expect(publishGuest({ ...artifact, key: "latest/bun.wasm.gz" }, store)).rejects.toThrow("key does not match");
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
  await expect(verifyPublicGuest(artifact.descriptor, async () => new Response(null, { status: 404 }))).rejects.toThrow("HTTP 404");
  await expect(verifyPublicGuest(artifact.descriptor, async () => new Response(Buffer.concat([wasm, new Uint8Array([0, 1, 0])]), { headers: publicHeaders }))).rejects.toThrow("integrity mismatch");
  await verifyPublicGuest(artifact.descriptor, async () => new Response(Buffer.from(artifact.gzip), { headers: publicHeaders }));
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
    uploading = store.upload(artifact);
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
