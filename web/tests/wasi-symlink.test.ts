import { expect, test } from "bun:test";
import { host } from "./wasi-host-fixture";

for (const target of ["../outside", "/outside", "sub/../../outside"]) {
  test(`a supported symlink cannot escape a directory capability through ${target}`, () => {
    const h = host();
    expect(h.calls.path_symlink(256, h.path(target), 3, 512, h.path("link", 512))).toBe(0);
    expect(h.fs.lookup("/allowed/link", false)).toMatchObject({ kind: "symlink", target });
    expect(h.open("link").result).toBe(32);
    expect(h.calls.path_open(3, 1, 256, h.path("link"), 0, 2n, 0n, 0, 1024)).toBe(63);
    expect(new TextDecoder().decode(h.fs.readFile("/outside"))).toBe("outside");
    expect(h.fs.lookup("/allowed/inside")?.kind).toBe("file");
  });
}

test("a supported symlink follows an ordinary target inside the directory capability", () => {
  const h = host();
  expect(h.calls.path_symlink(256, h.path("inside"), 3, 512, h.path("link", 512))).toBe(0);
  expect(h.calls.path_open(3, 1, 256, h.path("link"), 0, 2n, 0n, 0, 1024)).toBe(0);
  expect(new TextDecoder().decode(h.fs.readFile("/allowed/link"))).toBe("inside");
});
