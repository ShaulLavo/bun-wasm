import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function rejects(args: string[], diagnostic: string, guest = "") {
  const result = spawnSync(process.execPath, [new URL("./browser-network-consumer.ts", import.meta.url).pathname].concat(args), {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, NETWORK_CONSUMER_GUEST: guest },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain(diagnostic);
}

test("consumer browser gate rejects omitted and unknown engines instead of silently passing", () => {
  rejects([], "explicit known browsers required");
  rejects(["unknown"], "explicit known browsers required");
});

test("consumer browser gate requires an explicit borrowed artifact", () => {
  rejects(["chromium"], "NETWORK_CONSUMER_GUEST must be an absolute borrowed artifact path");
});

test("consumer browser gate rejects a guest without a build receipt before launching a browser", () => {
  const scratch = mkdtempSync(join(process.env.NETWORK_CONSUMER_SCRATCH ?? tmpdir(), "network-consumer-control-"));
  try {
    const guest = join(scratch, "wrong.wasm");
    writeFileSync(guest, new Uint8Array([0]));
    rejects(["chromium"], `${guest}.build.json`, guest);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
