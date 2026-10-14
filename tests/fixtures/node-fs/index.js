const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const dir = "work";
fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(dir, "a.txt"), "alpha");
fs.appendFileSync(path.join(dir, "a.txt"), "-beta");
console.log("read utf8:", fs.readFileSync("work/a.txt", "utf8"));
const buf = fs.readFileSync("work/a.txt");
console.log("read buffer:", Buffer.isBuffer(buf), buf.length, buf.toString("hex").slice(0, 6));
console.log("exists:", fs.existsSync("work/a.txt"), fs.existsSync("work/nope"));
const st = fs.statSync("work/a.txt");
console.log("stat:", st.isFile(), st.isDirectory(), st.size, st.mtime instanceof Date);
fs.mkdirSync("work/deep/er/dir", { recursive: true });
fs.writeFileSync("work/deep/er/file.bin", Buffer.from([1, 2, 3]));
console.log("readdir:", fs.readdirSync("work").sort().join(","));
console.log("readdir types:", fs.readdirSync("work", { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).map((d) => `${d.name}:${d.isDirectory() ? "d" : "f"}`).join(","));
console.log("readdir recursive:", fs.readdirSync("work/deep", { recursive: true }).sort().join(","));
fs.renameSync("work/a.txt", "work/b.txt");
fs.copyFileSync("work/b.txt", "work/c.txt");
console.log("rename+copy:", fs.readdirSync("work").sort().join(","), fs.readFileSync("work/c.txt", "utf8"));
fs.unlinkSync("work/c.txt");
fs.rmSync("work/deep", { recursive: true });
console.log("after rm:", fs.readdirSync("work").sort().join(","));
try {
  fs.readFileSync("work/missing.txt");
} catch (err) {
  console.log("ENOENT:", err.code, err.syscall, err.errno, err.message);
}
try {
  fs.mkdirSync("work");
} catch (err) {
  console.log("EEXIST:", err.code);
}
const fd = fs.openSync("work/fd.txt", "w+");
fs.writeSync(fd, "fd write");
const out = Buffer.alloc(8);
fs.readSync(fd, out, 0, 8, 0);
fs.closeSync(fd);
console.log("fd io:", out.toString());

fs.readFile("work/b.txt", "utf8", (err, data) => {
  console.log("callback readFile:", err, data);
  fs.writeFile("work/cb.txt", "via callback", (err2) => {
    console.log("callback writeFile:", err2, fs.readFileSync("work/cb.txt", "utf8"));
    fs.stat("work/nope", (err3) => console.log("callback error:", err3.code));
  });
});
(async () => {
  await fsp.writeFile("work/p.txt", "promised");
  console.log("promises readFile:", await fsp.readFile("work/p.txt", "utf8"));
  await fsp.mkdir("work/pdir/x", { recursive: true });
  console.log("promises readdir:", (await fsp.readdir("work/pdir")).sort().join(","));
  console.log("promises stat:", (await fsp.stat("work/p.txt")).size);
  await fsp.rm("work/pdir", { recursive: true, force: true });
  try {
    await fsp.readFile("work/none");
  } catch (err) {
    console.log("promises reject:", err.code);
  }
  const fh = await fsp.open("work/p.txt", "r");
  console.log("filehandle:", (await fh.readFile("utf8")).length);
  await fh.close();
})();
