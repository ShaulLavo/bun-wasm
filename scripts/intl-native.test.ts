import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-intl-native-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("engine-host preserves native Intl", () => {
  const source = join(scratch, "index.ts");
  writeFileSync(source, `
    console.log(JSON.stringify({
      polyfilled: Intl.NumberFormat.polyfilled === true,
      number: new Intl.NumberFormat("de-DE").format(1234.5),
      plural: new Intl.PluralRules("he").select(2),
    }));
  `);
  const result = Bun.spawnSync([
    "node", "--no-warnings", join(root, "web/scripts/node-host.mjs"),
    "--wasm", join(root, "dist/bun-browser.wasm"), "--dir", `${scratch}::/`,
    "--env", "PWD=/", "--env", "HOME=/", "--", "run", "/index.ts",
  ], { stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ polyfilled: false, number: "1.234,5", plural: "two" });
});
