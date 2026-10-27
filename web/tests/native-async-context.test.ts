import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

for (const mode of ["native", "fallback"]) {
  test(`captured Next metadata reader with ${mode} continuation storage`, () => {
    const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", new URL("./fixtures/native-async-context.ts", import.meta.url).pathname, mode], {
      encoding: "utf8", timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("pass");
  });
}
