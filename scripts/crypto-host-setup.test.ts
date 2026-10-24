import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBatches, discoverChecks, selectChecks } from "./test-checks";

test("host-key controls have exactly one normal blocking discovery owner", () => {
  const path = "scripts/crypto-host-keys.test.ts";
  expect(discoverChecks().filter(check => check.path === path)).toEqual([
    { owner: "web", path, localRuntime: false, batch: "10-web" },
  ]);
  expect(checkBatches("web")[0]).toContain(path);
  for (const owner of ["runtime", "local-runtime", "quality"]) expect(selectChecks(owner)).not.toContain(path);
  const web = readFileSync(new URL("./test-web-host.sh", import.meta.url), "utf8");
  expect(web.match(/bun \.\.\/scripts\/test-checks\.ts web\n/g)).toHaveLength(1);
});

test("host-key fixture uses the existing no-build native owner", () => {
  const path = "tests/fixtures/runtime-ts-host-crypto-keys";
  expect(discoverChecks().filter(check => check.path === path)).toEqual([
    { owner: "native", path, localRuntime: false, batch: "default" },
  ]);
});

for (const failRoot of [false, true]) {
  test(`fresh host-suite setup installs root test tools before applications, root failure=${failRoot}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "bun-wasm-host-setup-"));
    try {
      for (const name of ["bin", "scripts", "web", "sandbox"]) mkdirSync(join(directory, name));
      writeFileSync(join(directory, "scripts/test-web-host.sh"), readFileSync(new URL("./test-web-host.sh", import.meta.url)));
      writeFileSync(join(directory, "bin/bun"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "$PWD" "$*" >> "$INSTALL_TRACE"
[[ "$PWD" != "$FAIL_ROOT" ]] || exit 23
mkdir -p node_modules
`, { mode: 0o755 });
      expect(existsSync(join(directory, "node_modules"))).toBe(false);
      const result = spawnSync("bash", ["../scripts/test-web-host.sh", "--setup"], {
        cwd: join(directory, "web"),
        env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`, INSTALL_TRACE: join(directory, "installs"), FAIL_ROOT: failRoot ? directory : "" },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(failRoot ? 23 : 0);
      const installs = [`${directory}|install --frozen-lockfile --ignore-scripts`];
      if (!failRoot) installs.push(`${directory}/web|install --frozen-lockfile`, `${directory}/sandbox|install --frozen-lockfile`);
      expect(readFileSync(join(directory, "installs"), "utf8").trim().split("\n")).toEqual(installs);
      expect(existsSync(join(directory, "node_modules"))).toBe(!failRoot);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
