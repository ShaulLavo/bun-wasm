import assert from "node:assert/strict";
import path from "node:path";

const w = path.win32;
assert.equal(w.basename("C:\\dir\\file.txt"), "file.txt");
assert.equal(w.dirname("\\\\server\\share\\file.txt"), "\\\\server\\share\\");
assert.equal(w.extname("C:\\dir.with.dot\\file"), "");
assert.equal(w.normalize("bb..\\..\\x"), "x");
assert.equal(path.posix.normalize("bb../../x"), "x");
assert.equal(w.join("//server", "share", "dir", ".."), "\\\\server\\share\\");
assert.equal(w.resolve("C:/base", "//other/share", "C:relative"), "C:\\base\\relative");
const cwd = process.cwd();
process.chdir("/");
// Recorded with native Bun 1.4.2 (744846f84) at cwd /.
const nativeWindowsResolutions: { paths: string[]; expected: string }[] = [
  { paths: ["\\foo"], expected: "\\foo" },
  { paths: ["\\foo", "bar"], expected: "\\foo\\bar" },
  { paths: ["C:\\"], expected: "C:\\" },
  { paths: ["C:"], expected: "C:\\" },
  { paths: ["C:foo"], expected: "C:\\foo" },
  { paths: ["C:\\base", "C:relative"], expected: "C:\\base\\relative" },
  { paths: ["C:\\base", "D:relative"], expected: "D:\\relative" },
  { paths: ["\\\\server\\share"], expected: "\\\\server\\share\\" },
  { paths: ["\\\\server\\share\\x"], expected: "\\\\server\\share\\x" },
  { paths: ["\\\\?\\"], expected: "\\?" },
  { paths: ["\\\\.\\"], expected: "\\" },
  { paths: ["\\\\?\\C:\\"], expected: "\\\\?\\C:\\" },
  { paths: ["\\\\.\\C:\\"], expected: "\\\\.\\C:\\" },
  { paths: ["bar", "bar"], expected: "\\bar\\bar" },
  { paths: ["baz\\qux", ""], expected: "\\baz\\qux" },
  { paths: ["bar", ".."], expected: "\\" },
];
try {
  for (const { paths, expected } of nativeWindowsResolutions) assert.equal(w.resolve(...paths), expected, JSON.stringify(paths));
} finally {
  process.chdir(cwd);
}
assert.equal(w.relative("C:\\A\\B", "c:\\a\\C"), "..\\C");
assert.equal(w.relative("\\\\server\\share-one", "\\\\server\\share-two"), "..\\share-two");
assert.equal(path.resolve(undefined, "/absolute"), "/absolute");
assert.throws(() => w.resolve(undefined, "C:\\absolute"), TypeError);
assert.throws(() => path.basename(undefined, 7), /"ext"/);
assert.equal(w.toNamespacedPath("//server/share/file"), "\\\\?\\UNC\\server\\share\\file");
assert.equal(w._makeLong, w.toNamespacedPath);
assert.equal(path._makeLong, path.toNamespacedPath);
assert.equal(w.matchesGlob("src\\file.ts", "**\\*.ts"), true);
assert.deepEqual(w.parse("C:\\dir\\file.txt"), { root: "C:\\", dir: "C:\\dir", base: "file.txt", ext: ".txt", name: "file" });
console.log("Windows roots, drives, UNC and namespaces");

for (const p of [path.posix, w]) {
  const separator = p.sep;
  const raw = "\ud800\ufeff日本😀";
  assert.equal(p.basename("dir" + separator + raw), raw);
  assert.equal(p.normalize(raw + separator + ".." + separator + raw), raw);
  assert.equal(p.format({ dir: "d".repeat(70000), name: raw, ext: "txt" }), "d".repeat(70000) + separator + raw + ".txt");
  const converted: string[] = [];
  const first = Object.assign(new String("ignored"), { [Symbol.toPrimitive]() { converted.push("first"); return "base"; } });
  const second = Object.assign(new String("ignored"), { [Symbol.toPrimitive]() { converted.push("second"); return "file"; } });
  assert.equal(p.join(first, second), "base" + separator + "file");
  assert.deepEqual(converted, ["first", "second"]);
}
console.log("UTF-16, long paths and argument coercion");
