import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyGuestBuildReceipt, verifyGuestCompanions } from "../../../scripts/guest-build-receipt.ts";

const host = process.env.BUN_WASM_NATIVE_HOST;
assert(host, "BUN_WASM_NATIVE_HOST must name the actual native launcher");
const root = join(import.meta.dir, "../../..");

function launch(args: string[]) {
  assert(host);
  const child = Bun.spawnSync([host].concat(args), { cwd: root, timeout: 60_000 });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  assert.equal(child.stderr.toString(), "");
  return child.stdout.toString();
}

test("normal build records matching core and engine bytes", async () => {
  const path = join(root, "dist/bun.wasm");
  const receipt: unknown = JSON.parse(readFileSync(`${path}.build.json`, "utf8"));
  verifyGuestBuildReceipt(readFileSync(path), receipt);
  await verifyGuestCompanions(receipt, join(root, "dist"));
});

test("default native command starts without explicit pair setup", () => {
  assert.match(launch(["--version"]), /^\d+\.\d+\.\d+\n$/);
  assert.equal(launch(["-e", "console.log(42)"]), "42\n");
}, 120_000);

test("default native driver imports TypeScript and runs promises and a timer", () => {
  assert.equal(launch(["--dir", `${join(import.meta.dir, "fixtures")}::/fixture`, "run", "/fixture/main.ts"]), "42\n");
}, 60_000);
