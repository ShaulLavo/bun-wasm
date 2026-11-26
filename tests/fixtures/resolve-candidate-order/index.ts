// Candidate order the resolver must keep when it checks a whole candidate list at once:
// extensions in Bun's order, a file before a same-named directory, `main` before
// `main/index`, the nearest `node_modules` first, and the walk going on past a
// nearer package folder that resolves nothing.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(process.cwd(), "resolve-candidate-order-cases");
rmSync(root, { recursive: true, force: true });

function write(path: string, contents: string) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}
const marker = (name: string) => `module.exports = ${JSON.stringify(name)};\n`;

write("app/ext/x.ts", marker("x.ts"));
write("app/ext/x.js", marker("x.js"));
write("app/ext/x.json", "\"x.json\"");
write("app/both.js", marker("both.js"));
write("app/both/index.js", marker("both/index.js"));
write("app/alt/y.ts", marker("y.ts for y.js"));
write("app/onlyjson/data.json", "\"data.json\"");
write("node_modules/far/index.js", marker("far: outer node_modules"));
write("app/node_modules/near/index.js", marker("near: app node_modules"));
write("node_modules/near/index.js", marker("near: outer node_modules"));
// A nearer folder with nothing to resolve: Bun keeps searching outer node_modules.
mkdirSync(join(root, "app/deep/node_modules/far"), { recursive: true });
write("node_modules/main-dir/package.json", JSON.stringify({ main: "lib" }));
write("node_modules/main-dir/lib/index.js", marker("main-dir: main/index.js"));
write("node_modules/main-file/package.json", JSON.stringify({ main: "lib" }));
write("node_modules/main-file/lib.js", marker("main-file: main.js before main/index"));
write("node_modules/main-file/lib/index.js", marker("main-file: main/index.js"));
write("real/linked/index.js", marker("linked: through a symlink"));
mkdirSync(join(root, "app/node_modules"), { recursive: true });
symlinkSync("../../real/linked", join(root, "app/node_modules/linked"));
write("app/deep/more/entry.js", "");
write(
  "app/deep/more/entry.mjs",
  "export const resolve = (specifier) => import.meta.resolve(specifier);\nexport const load = (specifier) => import(specifier);\n",
);

const from = createRequire(join(root, "app/deep/more/entry.js"));
const app = createRequire(join(root, "app/entry.js"));
const cases: [string, NodeJS.Require][] = [
  ["../../ext/x", from],
  ["./ext/x", app],
  ["./both", app],
  ["./alt/y.js", app],
  ["./onlyjson/data", app],
  ["far", from],
  ["near", from],
  ["main-dir", app],
  ["main-file", app],
  ["linked", from],
];
for (const [specifier, require] of cases) console.log(`require ${specifier}: ${require(specifier)}`);

const { resolve, load } = await import(pathToFileURL(join(root, "app/deep/more/entry.mjs")).href);
for (const specifier of ["far", "near", "main-file"]) {
  const resolved = resolve(specifier);
  console.log(`import ${specifier}: ${resolved.slice(pathToFileURL(root).href.length)}`);
}
console.log(`import linked: ${(await load("linked")).default}`);
for (const specifier of ["missing-package", "../../ext/missing"]) {
  try {
    from(specifier);
    console.log(`require ${specifier}: resolved`);
  } catch (error) {
    console.log(`require ${specifier}: ${(error as { code?: string }).code}`);
  }
}
rmSync(root, { recursive: true, force: true });
