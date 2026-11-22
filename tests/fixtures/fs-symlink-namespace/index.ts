import fs from "node:fs";
import { join, relative } from "node:path";

// Absolute symlink targets name paths in the guest's own namespace: they are stored as written,
// read back as written, and followed by open, stat, realpath, readdir and cp. A link that climbs
// past the root stays at the root. cp copies a link as a link, its target resolved, as Bun does.
const base = join(process.cwd(), "links");
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(join(base, "from/dir"), { recursive: true });
fs.writeFileSync(join(base, "from/a.txt"), "a");
fs.writeFileSync(join(base, "from/dir/c.txt"), "c");
const real = fs.realpathSync(base);
const show = (path: string) => relative(base, path);
const kind = (entry: fs.Dirent) => entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file";

fs.symlinkSync(join(base, "from/a.txt"), join(base, "from/abs"));
fs.symlinkSync(join(base, "from/dir"), join(base, "from/dirlink"));
fs.symlinkSync("../a.txt", join(base, "from/dir/rel"));
console.log("readlink", show(fs.readlinkSync(join(base, "from/abs"))), fs.readlinkSync(join(base, "from/dir/rel")));
console.log("lstat", fs.lstatSync(join(base, "from/abs")).isSymbolicLink(), "stat", fs.statSync(join(base, "from/abs")).isFile());
console.log("read", fs.readFileSync(join(base, "from/abs"), "utf8"), fs.readFileSync(join(base, "from/dirlink/c.txt"), "utf8"),
  fs.readFileSync(join(base, "from/dirlink/rel"), "utf8"));
console.log("realpath", relative(real, fs.realpathSync(join(base, "from/dirlink/rel"))), relative(real, await fs.promises.realpath(join(base, "from/abs"))));
console.log("readdir", fs.readdirSync(join(base, "from"), { withFileTypes: true }).map(entry => `${entry.name}:${kind(entry)}`).sort().join(" "));
console.log("through link", fs.readdirSync(join(base, "from/dirlink")).sort().join(" "));

fs.cpSync(join(base, "from"), join(base, "to"), { recursive: true });
for (const name of ["abs", "dirlink", "dir/rel"]) {
  console.log("copied", name, fs.lstatSync(join(base, "to", name)).isSymbolicLink(), show(fs.readlinkSync(join(base, "to", name))));
}
await fs.promises.cp(join(base, "from/abs"), join(base, "single"));
console.log("single", fs.lstatSync(join(base, "single")).isSymbolicLink(), fs.readFileSync(join(base, "single"), "utf8"));

fs.symlinkSync("../".repeat(64) + "bun-wasm-no-such-file", join(base, "climb"));
try {
  fs.readFileSync(join(base, "climb"));
} catch (error) {
  console.log("climb", (error as NodeJS.ErrnoException).code);
}
fs.symlinkSync(join(base, "loop-b"), join(base, "loop-a"));
fs.symlinkSync(join(base, "loop-a"), join(base, "loop-b"));
try {
  fs.statSync(join(base, "loop-a"));
} catch (error) {
  console.log("loop", (error as NodeJS.ErrnoException).code);
}

fs.rmSync(base, { recursive: true });
console.log("removed", fs.existsSync(base));
