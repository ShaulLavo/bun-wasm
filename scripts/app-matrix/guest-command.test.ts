import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { guestCommand } from "./guest-command.ts";

const request = {
  project: { root: "/work/tmp/case with spaces", path: "/work/tmp/case with spaces/app" }, args: ["run", "node_modules/vite/bin/vite.js"],
  port: 3137, registry: "http://127.0.0.1:8000",
};

test("guest project and writable locations live below the filesystem root", () => {
  const command = guestCommand({ ...request, host: ["/launcher", "--wasm", "/core.wasm"] });
  expect(command).toContain(`${request.project.path}::/app`);
  expect(command).toContain(`${request.project.root}::/`);
  for (const entry of ["PWD=/app", "HOME=/app", "TMPDIR=/app/tmp", "BUN_INSTALL_CACHE_DIR=/app/.cache"]) {
    expect(command).toContain(entry);
  }
});

for (const host of [["/launcher", "--wasm", "/core.wasm"], ["node", "--no-warnings", "/node-host.mjs", "--net", "--wasm", "/browser.wasm"]]) {
  test(`guest workspace keeps the selected ${host[0]} host, artifact, arguments and network settings`, () => {
    const command = guestCommand({ ...request, host });
    expect(command.slice(0, host.length)).toEqual(host);
    expect(command.slice(command.indexOf("--") + 1)).toEqual(request.args);
    expect(command).toContain("PORT=3137");
    expect(command).toContain("PRISMA_ENGINES_MIRROR=http://127.0.0.1:8000/blocked-prisma-engines");
    expect(command).toContain("BUN_WASM_TRACE_EXIT=1");
    expect(command.filter(value => value === "--dir")).toHaveLength(2);
  });
}

function runnerIdentity(product: boolean, helper: string) {
  const runner = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const expression = runner.match(/runnerSources = (Object\.fromEntries[^\n]+);/)?.[1];
  assert.ok(expression, "Missing authoritative runner source inventory");
  const helperPath = new URL("./guest-command.ts", import.meta.url).pathname;
  const identity: unknown = runInNewContext(expression, {
    root: resolve(import.meta.dir, "../.."), options: { product }, join,
    sha256: (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex"),
    readFileSync: (path: string) => path === helperPath ? Buffer.from(helper) : readFileSync(path),
  });
  assert.ok(identity && typeof identity === "object");
  return new Map<string, unknown>(Object.entries(identity));
}

for (const product of [false, true]) {
  test(`a helper-only edit changes recorded runner identity with product=${product}`, () => {
    const helper = readFileSync(new URL("./guest-command.ts", import.meta.url), "utf8");
    const changed = helper.replaceAll("/app", "/workspace");
    expect(changed).not.toBe(helper);
    const before = runnerIdentity(product, helper);
    const after = runnerIdentity(product, changed);
    expect(before.has("guest-command.ts")).toBe(true);
    expect(after.get("guest-command.ts")).not.toBe(before.get("guest-command.ts"));
    expect(Array.from(after).filter(([path, hash]) => hash !== before.get(path)).map(([path]) => path)).toEqual(["guest-command.ts"]);
    expect(after.get("run.mjs")).toBe(before.get("run.mjs"));
  });
}
