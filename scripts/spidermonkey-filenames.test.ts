import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("SpiderMonkey diagnostic filenames and host replies preserve virtual IDs", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-filenames-"));
  try {
    const boundary = join(scratch, "filename");
    execFileSync("c++", ["-std=c++20", "-Wall", "-Wextra", "-Werror", "-o", boundary,
      resolve("crates/bunwasm-spidermonkey/tests/filename.cpp")]);
    execFileSync(boundary, [], { stdio: "inherit" });
    const replies = join(scratch, "reply-buffer");
    execFileSync("rustc", ["--edition=2024", "--test", "-o", replies,
      resolve("crates/bunwasm-engine-spidermonkey/src/reply_buffer.rs")]);
    execFileSync(replies, [], { stdio: "inherit" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
