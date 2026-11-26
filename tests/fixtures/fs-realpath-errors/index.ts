import fs from "node:fs";
import { join, relative } from "node:path";

// realpath answers in one host call: links through a node_modules-style tree, relative input,
// results longer than the guest's first buffer, and
// realpath(3)'s errors, as native Bun reports them.
const base = join(process.cwd(), "realpath-errors");
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(join(base, "store/pkg@1/node_modules/pkg/lib"), { recursive: true });
fs.mkdirSync(join(base, "app/node_modules"), { recursive: true });
fs.writeFileSync(join(base, "store/pkg@1/node_modules/pkg/lib/index.js"), "");
fs.symlinkSync("../../store/pkg@1/node_modules/pkg", join(base, "app/node_modules/pkg"));
fs.symlinkSync("missing/file", join(base, "dangling"));
fs.symlinkSync("self", join(base, "self"));
const real = fs.realpathSync(base);
const show = (path: string) => relative(real, path);
const code = (run: () => unknown) => {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
};

console.log("link", show(fs.realpathSync(join(base, "app/node_modules/pkg/lib/index.js"))));
// Bun folds `..` before resolving, as Node's fs.realpathSync does.
console.log("dotdot", JSON.stringify(show(fs.realpathSync(join(base, "app/node_modules/pkg/lib/../../..")))));
console.log("trailing", show(fs.realpathSync(join(base, "app/node_modules/pkg/lib/"))));
console.log("native", show(fs.realpathSync.native(join(base, "app/node_modules/pkg"))));
process.chdir(join(base, "app"));
console.log("relative", show(fs.realpathSync("node_modules/pkg/lib")), show(fs.realpathSync(".")));
console.log("promise", show(await fs.promises.realpath(join(base, "app/node_modules/pkg"))));

let deep = "";
for (let i = 0; i < 12; i++) deep = join(deep, "d".repeat(100));
fs.mkdirSync(join(base, "deep", deep), { recursive: true });
fs.symlinkSync("deep", join(base, "long"));
const long = fs.realpathSync(join(base, "long", deep));
console.log("long", long.length > 1024, show(long) === join("deep", deep));

console.log("missing", code(() => fs.realpathSync(join(base, "app/none"))));
console.log("missing parent", code(() => fs.realpathSync(join(base, "none/file"))));
console.log("dangling", code(() => fs.realpathSync(join(base, "dangling"))));
console.log("not a directory", code(() => fs.realpathSync(join(base, "store/pkg@1/node_modules/pkg/lib/index.js/x"))));
console.log("trailing file", code(() => fs.realpathSync(join(base, "store/pkg@1/node_modules/pkg/lib/index.js/"))));
console.log("loop", code(() => fs.realpathSync(join(base, "self"))));
fs.realpath(join(base, "none"), (error) => console.log("callback", error?.code));

process.chdir(process.env.HOME ?? "/");
process.on("exit", () => fs.rmSync(base, { recursive: true }));
