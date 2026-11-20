import { setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

test("the panic hook reports payloads and locations with a bounded fatal fallback", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-panic-report-"));
  try {
    const executable = join(scratch, "panic-report");
    execFileSync("rustc", ["--edition=2021", "-C", "panic=abort", "-o", executable,
      resolve("crates/bunwasm-spidermonkey/tests/fixtures/panic-report-control.rs")]);
    for (const [mode, message] of [["string", "selected-engine panic control"], ["owned", "owned panic control"], ["opaque", "non-string panic payload"]] as const) {
      const result = spawnSync(executable, [mode], { encoding: "utf8", timeout: 60_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 134);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /SpiderMonkey Rust panic at .*panic-report-control\.rs:\d+:\d+: /);
      assert(result.stderr.endsWith(message));
    }
    const overflow = spawnSync(executable, ["overflow"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(overflow.error, undefined);
    assert.equal(overflow.status, 134);
    assert.equal(overflow.stderr, "SpiderMonkey Rust panic (report exceeded fixed buffer)");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
