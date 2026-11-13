const { spawnSync }: typeof import("node:child_process") = require("node:child_process");

const callbackDepth = 16;

function callbackSource(): string {
  return "return " + "foo(() => { return ".repeat(callbackDepth) + "42;" + " });".repeat(callbackDepth);
}

function loadCallbacks(): void {
  const value = new Function("foo", callbackSource())((callback: () => number) => callback());
  if (value !== 42) throw new Error(`nested callbacks returned ${value}`);
}

function recover(): void {
  if ((0, eval)("21 * 2") !== 42) throw new Error("parser did not recover");
}

function run(): void {
  loadCallbacks();
  console.log("nested callbacks loaded");

  const deep = "(() => ".repeat(200000) + "0" + ")".repeat(200000);
  try {
    (0, eval)(deep);
    throw new Error("deep valid arrow syntax did not overflow");
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    console.log("deep parser overflow caught");
  }
  recover();
  loadCallbacks();
  console.log("nested callbacks reloaded");
  console.log("continued");
}

if (process.argv[2] === "run") {
  run();
} else {
  const child = spawnSync(process.execPath, [__filename, "run"], {
    env: { ...process.env, BUN_WASM_STACK_KIB: "32" }, encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  if (child.status !== 0) throw new Error(`32 KiB parser child exited ${child.status}`);
}
