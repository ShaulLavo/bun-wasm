import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderedAppender } from "./ordered-append";

test("records land in call order, and a failed write lets later records through", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-ordered-append-"));
  try {
    const path = join(root, "evidence.jsonl");
    const append = orderedAppender(path);
    const records = Array.from({ length: 200 }, (_, index) => `${JSON.stringify({ index, pad: "x".repeat(index * 37 % 4096) })}\n`);
    await Promise.all(records.map(append));
    expect(await readFile(path, "utf8")).toBe(records.join(""));

    const missing = orderedAppender(join(root, "missing", "evidence.jsonl"));
    const failed = missing("first\n");
    const later = missing("second\n");
    await expect(failed).rejects.toThrow();
    await expect(later).rejects.toThrow();
    // The chain survives the rejection: the next write still runs (and here fails the same way).
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected record does not stop the next one on a writable file", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-ordered-append-"));
  try {
    const path = join(root, "evidence.jsonl");
    const append = orderedAppender(path);
    const bad = append(Symbol("not text") as unknown as string);
    const good = append("after\n");
    await expect(bad).rejects.toThrow();
    await good;
    expect(await readFile(path, "utf8")).toBe("after\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
