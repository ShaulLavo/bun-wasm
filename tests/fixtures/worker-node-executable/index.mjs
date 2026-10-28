// A process started as `node` creates a file-entry worker. Its operands are files, so
// the worker must not be started as `node run <file>` (vinxi's ssr build child calls
// esbuild-wasm's transformSync, whose worker is a file).
import { spawn } from "node:child_process";
const child = spawn("node", ["child.mjs"], { stdio: ["ignore", "inherit", "inherit"] });
const code = await new Promise(resolve => child.once("exit", resolve));
console.log("child exit", code);
