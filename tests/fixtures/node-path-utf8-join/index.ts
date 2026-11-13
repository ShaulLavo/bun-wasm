import assert from "node:assert/strict";
import path from "node:path";

const codePoints = [0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xfeff, 0xffff, 0x10000, 0x1f600, 0x10ffff];
const names = codePoints.map(value => String.fromCodePoint(value)).concat([
  "日本", "é", "e\u0301", "😀..", "..😀", "\ufeff😀\0", "😀".repeat(35001),
]);

for (const namespace of [path.posix, path.win32]) {
  const separator = namespace.sep;
  for (const name of names) {
    assert.equal(namespace.join("dir", name, "leaf"), ["dir", name, "leaf"].join(separator));
    assert.equal(namespace.join("dir", name, "..", "leaf"), ["dir", "leaf"].join(separator));
    assert.equal(namespace.join(name, "..", "leaf"), "leaf");
    assert.equal(namespace.join("", name, ""), name);
    assert.equal(namespace.join("dir", name + separator), "dir" + separator + name + separator);
  }
  assert.equal(namespace.join("\ud800", "\udfff"), "\ud800" + separator + "\udfff");
  assert.equal(namespace.join("😀", "\ud800", "..", "leaf"), "😀" + separator + "leaf");
}

assert.equal(path.win32.join("//😀", "日本", "leaf"), "\\\\😀\\日本\\leaf");
assert.equal(path.win32.join("C:\\", "😀", "..", "é"), "C:\\é");
assert.equal(path.posix.join("/", "😀", "..", "é"), "/é");
console.log("node:path UTF-8 join boundaries");
