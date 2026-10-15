import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, sha256 } from "./registry.mjs";

test("offline mirror rewrites tarballs, verifies objects, and refuses missing records without fetching", async () => {
  const directory = mkdtempSync("/work/tmp/bun-wasm-app-matrix-registry-test-");
  let mirror;
  const fetch = globalThis.fetch;
  try {
    mkdirSync(join(directory, "objects"));
    const bytes = Buffer.from('{"dist":{"tarball":"https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"}}');
    const digest = sha256(bytes);
    writeFileSync(join(directory, "objects", digest), bytes);
    writeFileSync(join(directory, "index.json"), JSON.stringify({ "/pkg": { status: 200, type: "application/json", sha256: digest } }));
    globalThis.fetch = () => { throw new Error("Offline replay attempted upstream fetch"); };
    mirror = await registry({ directory, record: false });
    const response = await fetch(`${mirror.base}/pkg`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dist: { tarball: `${mirror.base}/pkg/-/pkg-1.0.0.tgz` } });
    expect((await fetch(`${mirror.base}/unrecorded`)).status).toBe(503);
    expect(mirror.misses).toEqual(["/unrecorded"]);
    await mirror.close();
    mirror = undefined;
    writeFileSync(join(directory, "objects", digest), "corrupt");
    mirror = await registry({ directory, record: false });
    expect((await fetch(`${mirror.base}/pkg`)).status).toBe(502);
    expect(mirror.errors[0]).toContain("Corrupt registry object");
  } finally {
    globalThis.fetch = fetch;
    await mirror?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
