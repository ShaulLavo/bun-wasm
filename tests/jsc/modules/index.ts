// Bundled imports: relative TS modules, default/named/namespace, JSON, a node_modules package,
// a CommonJS module, and node builtins.
import { join, basename } from "node:path";
import * as util from "./src/util";
import Stack, { VERSION } from "./src/stack";
import data from "./src/data.json";
import tiny from "tiny-pkg";
const legacy = require("./src/legacy.cjs");

const s = new Stack<number>();
s.push(1); s.push(2);
console.log(VERSION, s.pop(), s.size);
console.log(util.double(21), util.greet("modules"));
console.log(data.name, data.list.length);
console.log(tiny(3), legacy.kind, legacy.add(2, 3));
console.log(join("/a", "b", "../c"), basename("/x/y/z.txt", ".txt"));
