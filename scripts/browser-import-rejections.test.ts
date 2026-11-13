import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const wasm = process.env.BUN_WASM_TEST_BROWSER_WASM ?? join(root, "dist/bun-browser.wasm");

function checkRejections(modules: string, extension: string): void {
      const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-import-rejection-"));
      try {
        writeFileSync(join(scratch, "failure.mjs"), 'throw new Error("dynamic-import-startup-marker");\n');
        const run = (source: string) => {
          writeFileSync(join(scratch, `entry.${extension}`), source);
          return spawnSync("node", ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--wasm", wasm,
            "--modules", modules, "--context", "hooks", "--dir", `${scratch}::/`, "--env", "PWD=/", "--",
            "run", `/entry.${extension}`], { cwd: root, encoding: "utf8", timeout: 30000 });
        };
        const ignored = run('import("./failure.mjs");');
        expect(ignored.error).toBeUndefined();
        expect(ignored.status, ignored.stderr).toBe(1);
        expect(ignored.stderr).toContain("dynamic-import-startup-marker");
        const caught = run('import("./failure.mjs").catch(error => console.log("caught", error.message));');
        expect(caught.error).toBeUndefined();
        expect(caught.status, caught.stderr).toBe(0);
        expect(caught.stdout).toBe("caught dynamic-import-startup-marker\n");
        expect(caught.stderr).toBe("");
      } finally { rmSync(scratch, { recursive: true, force: true }); }
}

for (const modules of ["records", "store"]) {
  for (const extension of ["mjs", "cjs"]) {
    test(`${modules} ${extension} dynamic imports preserve unhandled and caught rejections`, () => checkRejections(modules, extension), 90000);
  }
}
