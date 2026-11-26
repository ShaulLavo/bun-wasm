import { expect, test } from "bun:test";
import { MemFS } from "waffle/fs/memory";
import { clearEarlyStaging } from "../src/install-staging";

test("boot clears every early-install staging directory in /tmp and nothing else", async () => {
  const fs = new MemFS();
  fs.mkdirp("/tmp/bun-wasm-early-0123/1/lib");
  fs.writeFile("/tmp/bun-wasm-early-0123/1/lib/index.js", "staged");
  fs.mkdirp("/tmp/bun-wasm-early-4567");
  fs.writeFile("/tmp/kept.txt", "kept");
  fs.mkdirp("/tmp/other-bun-wasm-early-89");
  fs.mkdirp("/home/user/bun-wasm-early-project");

  const names = (path: string) => {
    const entry = fs.lookup(path);
    return entry?.kind === "dir" ? Array.from(entry.children.keys()).toSorted() : [];
  };

  expect(await clearEarlyStaging(fs)).toBe(2);
  expect(names("/tmp")).toEqual(["kept.txt", "other-bun-wasm-early-89"]);
  expect(fs.lookup("/home/user/bun-wasm-early-project")?.kind).toBe("dir");
});

test("boot cleanup tolerates a missing temporary directory", async () => {
  expect(await clearEarlyStaging(new MemFS())).toBe(0);
});
