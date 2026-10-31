import { expect, test } from "bun:test";
import type { Runtime } from "waffle";
import { armPromptReadBarrier } from "./shell-prompt-check";

function filesystem() {
  const calls: { receiver: unknown; path: string }[] = [];
  const source: Pick<Runtime["filesystem"], "readFile"> = {
    async readFile(this: unknown, path: string) {
      calls.push({ receiver: this, path });
      return new TextEncoder().encode("tracked");
    },
  };
  return { source, calls };
}

test("prompt read barrier preserves receiver and arguments, then restores the original method", async () => {
  const fixture = filesystem();
  const original = fixture.source.readFile;
  const barrier = armPromptReadBarrier(fixture.source, "/tracked");
  const pending = fixture.source.readFile("/tracked");
  await barrier.entered;
  expect(fixture.calls).toEqual([]);
  barrier.release();
  expect(new TextDecoder().decode(await pending)).toBe("tracked");
  expect(fixture.calls).toEqual([{ receiver: fixture.source, path: "/tracked" }]);
  barrier.restore();
  expect(fixture.source.readFile).toBe(original);
});

test("prompt read barrier restores after a rejected read", async () => {
  const source: Pick<Runtime["filesystem"], "readFile"> = {
    async readFile() { throw new Error("read failed"); },
  };
  const original = source.readFile;
  const barrier = armPromptReadBarrier(source, "/tracked");
  const pending = source.readFile("/tracked").catch(error => error);
  await barrier.entered;
  barrier.restore();
  expect(await pending).toEqual(new Error("read failed"));
  expect(source.readFile).toBe(original);
});
