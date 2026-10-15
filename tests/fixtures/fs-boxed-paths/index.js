import path from "node:path";
import fs from "node:fs";
import { exists, readFile, writeFile, rename, rm } from "node:fs/promises";
const boxed = new String("boxed.txt");
await writeFile(boxed, "boxed");
console.log(await exists(boxed), await readFile(boxed, "utf8"), fs.existsSync(boxed));
console.log(path.join(new String("a"), "b"), path.normalize(new String("a/../b")));
console.log(path.basename(new String("a/b.txt")), path.dirname(new String("a/b.txt")), path.extname(new String("a/b.txt")));
console.log(path.relative(new String("/a"), new String("/a/b")), path.isAbsolute(new String("/a")));
console.log(JSON.stringify(path.parse(new String("/a/b.txt"))));
const renamed = new String("renamed.txt");
await rename(boxed, renamed);
await rm(renamed);
console.log(await exists(boxed), await exists(renamed), await exists(null), await exists("bad\0path"));
try { path.join({ toString() { return "a"; } }, "b"); } catch (error) { console.log(error.code); }
