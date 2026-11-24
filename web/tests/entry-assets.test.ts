import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryAssetName, entryAssetUrl } from "../src/entry-assets";
import { siblingWorkerUrl } from "../src/bun-launcher";
import { publishVersionedEntries, rewriteEntryHtml, VERSIONED_ENTRY_FILES, VERSIONED_WORKER_FILES } from "../../scripts/browser-build";

const originalAssets = Object.getOwnPropertyDescriptor(globalThis, "__bunwasmAssets");
afterEach(() => {
  if (originalAssets) Object.defineProperty(globalThis, "__bunwasmAssets", originalAssets);
  else Reflect.deleteProperty(globalThis, "__bunwasmAssets");
});

test("entryAssetName and entryAssetUrl resolve hashed filenames from __bunwasmAssets and fall back cleanly", () => {
  Reflect.deleteProperty(globalThis, "__bunwasmAssets");
  expect(entryAssetName("worker.js")).toBe("worker.js");
  expect(entryAssetUrl("./__bunwasm/worker.js", "https://example.test/").href).toBe("https://example.test/__bunwasm/worker.js");
  expect(siblingWorkerUrl("https://example.test/__bunwasm/worker.js", "notification-worker.js")).toBe("https://example.test/__bunwasm/notification-worker.js");

  Reflect.set(globalThis, "__bunwasmAssets", {
    "worker.js": "entry-worker-0123456789abcdef.js",
    "notification-worker.js": "entry-notification-worker-fedcba9876543210.js",
    "preview1-worker.js": "entry-preview1-worker-1111222233334444.js",
    "evil.js": "../escape.js",
  });
  expect(entryAssetName("worker.js")).toBe("entry-worker-0123456789abcdef.js");
  expect(entryAssetName("evil.js")).toBe("evil.js");
  expect(entryAssetName("unknown.js")).toBe("unknown.js");
  expect(entryAssetUrl("./__bunwasm/worker.js", "https://example.test/").href).toBe("https://example.test/__bunwasm/entry-worker-0123456789abcdef.js");
  expect(entryAssetUrl("./fs-worker.js", "https://example.test/playground/").href).toBe("https://example.test/playground/fs-worker.js");
  expect(siblingWorkerUrl("https://example.test/__bunwasm/entry-worker-0123456789abcdef.js", "notification-worker.js"))
    .toBe("https://example.test/__bunwasm/entry-notification-worker-fedcba9876543210.js");
  expect(siblingWorkerUrl("https://example.test/__bunwasm/entry-worker-0123456789abcdef.js", "preview1-worker.js"))
    .toBe("https://example.test/__bunwasm/entry-preview1-worker-1111222233334444.js");
});

test("publishVersionedEntries emits content-hashed copies, mirrors scoped workers, and rewrites index.html", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bun-wasm-versioned-entries-"));
  try {
    for (const name of VERSIONED_ENTRY_FILES) await Bun.write(join(dir, name), `/* ${name} v1 */`);
    const v1 = await publishVersionedEntries(dir);
    for (const name of VERSIONED_ENTRY_FILES) {
      expect(v1[name]).toMatch(/^entry-[\w.-]+-[0-9a-f]{16}\.(?:js|css)$/);
      expect(await Bun.file(join(dir, v1[name]!)).text()).toBe(`/* ${name} v1 */`);
    }
    for (const scoped of ["worker.js", "fs-worker.js", "preview1-worker.js", "notification-worker.js"]) {
      expect(await Bun.file(join(dir, "__bunwasm", v1[scoped]!)).text()).toBe(`/* ${scoped} v1 */`);
    }
    expect(await Bun.file(join(dir, "__bunwasm", v1["shell-worker.js"]!)).exists()).toBe(false);
    const html = '<link rel="stylesheet" href="./main.css" /><script type="module" src="./main.js"></script>';
    const rewritten = rewriteEntryHtml(html, v1);
    expect(rewritten).toContain(`href="./${v1["main.css"]}"`);
    expect(rewritten).toContain(`src="./${v1["main.js"]}"`);
    expect(rewritten).not.toContain("./main.js");
    expect(rewritten).not.toContain("./main.css");

    // Changing a worker entry changes its hashed filename while keeping the rest stable.
    await Bun.write(join(dir, "worker.js"), "/* worker.js v2 import('./chunks/new-hash.js') */");
    const v2 = await publishVersionedEntries(dir);
    expect(v2["worker.js"]).not.toBe(v1["worker.js"]);
    expect(v2["main.js"]).toBe(v1["main.js"]);
    for (const worker of VERSIONED_WORKER_FILES) expect(v2[worker]).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
