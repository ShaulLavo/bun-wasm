// A chain of CommonJS modules that each require the next has to load inside the 32 KiB
// QuickJS stack budget a browser off V8 passes (docs/stack-limits.md). The child runs with that
// budget. Engines that ignore it, and native Bun, load the same chain with room to spare.
const { spawnSync }: typeof import("node:child_process") = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const Module: typeof import("node:module") = require("node:module");

const levels = 16;

function writeChain(name: string, length: number, leaf: string): string {
  const directory = path.join(process.cwd(), name);
  fs.mkdirSync(directory, { recursive: true });
  for (let i = 1; i <= length; i++) {
    const body = i < length ? `module.exports = require("./m${i + 1}.cjs") + 1;` : leaf;
    fs.writeFileSync(path.join(directory, `m${i}.cjs`), `${body}\n`);
  }
  return path.join(directory, "m1.cjs");
}

function loadChains(): void {
  if (require(writeChain("chain", levels, "module.exports = 1;")) !== levels) throw new Error("chain result changed");
  console.log(levels, "nested requires loaded");

  const overflowing = writeChain("overflow", 4, "function recurse() { return 1 + recurse(); }\nmodule.exports = recurse();");
  let caught = false;
  try { require(overflowing); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    caught = true;
  }
  if (!caught) throw new Error("unbounded recursion in a required module did not throw");
  const kept = Object.keys(require.cache).filter((file) => file.includes("/overflow/"));
  if (kept.length !== 0) throw new Error(`failed modules stayed cached: ${kept}`);
  console.log("overflow in a nested module caught, cache clean");

  if (require(writeChain("again", levels, "module.exports = 1;")) !== levels) throw new Error("second chain result changed");
  hookedChains();
  console.log("continued");
}

function hookedChains(): void {
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (specifier: string) {
    return originalRequire.call(this, specifier);
  };
  try {
    const hookedLevels = 24;
    if (require(writeChain("hooked", hookedLevels, "module.exports = 1;")) !== hookedLevels) throw new Error("hooked chain result changed");
    console.log(hookedLevels, "nested requires with a module hook loaded");
    expectHookOverflow(writeChain("hook-overflow", 256, "function recurse() { return 1 + recurse(); }\nmodule.exports = recurse();"));
    if (Object.keys(require.cache).some(file => file.includes("/hook-overflow/"))) throw new Error("failed hooked modules stayed cached");
    if (require(writeChain("hook-again", hookedLevels, "module.exports = 1;")) !== hookedLevels) throw new Error("hooked recovery result changed");
    console.log("module hook overflow caught, cache clean, hooked chain reloaded");
  } finally {
    Module.prototype.require = originalRequire;
  }
}

function expectHookOverflow(filename: string): void {
  try { require(filename); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return;
  }
  throw new Error("unbounded module hooks did not throw");
}

if (process.argv[2] === "load") {
  loadChains();
} else {
  const child = spawnSync(process.execPath, [__filename, "load"], { env: { ...process.env, BUN_WASM_STACK_KIB: "32" }, encoding: "utf8" });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  if (child.status !== 0) throw new Error(`chain child exited ${child.status}`);
}
