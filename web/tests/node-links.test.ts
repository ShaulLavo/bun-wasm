import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const NOENT = 44, LOOP = 32, REGULAR = 4, DIRECTORY = 3, SYMLINK = 7;

test("Node WASI symlinks resolve in the guest namespace and never leave the preopens", () => {
  const child = spawnSync("node", ["--no-warnings", new URL("./fixtures/node-links.ts", import.meta.url).pathname], { cwd: root, encoding: "utf8", timeout: 20000 });
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({
    // Absolute targets are stored as written and followed from guest `/`.
    create: 0, stored: "/tmp/d/a.txt", readlink: "/tmp/d/a.txt", lstat: [SYMLINK, 12], stat: [REGULAR, 6], fileSize: 6,
    dirlink: 0, through: [REGULAR, 6], trailing: DIRECTORY, readThrough: "/tmp/d/a.txt", mkdir: 0, made: true, rmdir: 0,
    dotDot: [REGULAR, 6], close: 0,
    // Guest-made and host-made links, and `..`, stop at guest `/`.
    climbing: [0, 0, 0, 0, 0],
    confined: Array.from({ length: 10 }, () => [NOENT, -NOENT]),
    landed: [0, true, false], placed: [0, true, false],
    guestRename: [0, NOENT, -NOENT, 0], hostRename: [0, NOENT, -NOENT, 0],
    loop: [0, 0, LOOP, -LOOP],
  });
});
