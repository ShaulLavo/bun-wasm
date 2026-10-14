const path = require("path");
const cases = [
  ["join", ["/a/b", "../c", "./d"]],
  ["join", ["a", "", "b/"]],
  ["resolve", ["/foo/bar", "./baz"]],
  ["resolve", ["/foo/bar", "/tmp/file/"]],
  ["normalize", ["/foo/bar//baz/asdf/quux/.."]],
  ["normalize", ["./a/../../b"]],
  ["relative", ["/data/orandea/test/aaa", "/data/orandea/impl/bbb"]],
  ["dirname", ["/a/b/c.txt"]],
  ["basename", ["/a/b/c.txt"]],
  ["basename", ["/a/b/c.txt", ".txt"]],
  ["extname", ["index.coffee.md"]],
  ["extname", [".hidden"]],
  ["isAbsolute", ["/x"]],
  ["isAbsolute", ["x/y"]],
];
for (const [fn, args] of cases) console.log(`${fn}(${args.map((a) => JSON.stringify(a)).join(", ")}) = ${JSON.stringify(path[fn](...args))}`);
console.log("parse:", JSON.stringify(path.parse("/home/user/dir/file.txt")));
console.log("format:", path.format({ dir: "/home/user/dir", name: "file", ext: ".txt" }));
console.log("sep/delimiter:", path.sep, path.delimiter, path.posix === path || path.posix.sep === "/");
import("node:path").then((m) => console.log("node:path esm default:", typeof m.default.join, typeof m.join));
