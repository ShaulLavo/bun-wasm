const { spawnSync }: typeof import("node:child_process") = require("node:child_process");

const callbackDepth = 16;
const assignmentCount = 100;
const assignmentWrapperDepth = 5;

function quickjsParser(): boolean {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  try { (0, eval)("let let = 1"); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (error.message === "'let' is not a valid lexical identifier") return true;
    if (error.message === "Unexpected keyword 'let'. Cannot use 'let' as an identifier name for a LexicalDeclaration." ||
        error.message === "let is disallowed as a lexically bound name") return false;
    throw new Error("Unrecognized parser fingerprint", { cause: error });
  }
  throw new Error("Invalid lexical declaration was accepted");
}
const quickjs = quickjsParser();

function callbackSource(): string {
  return "return " + "foo(() => { return ".repeat(callbackDepth) + "42;" + " });".repeat(callbackDepth);
}

function loadCallbacks(): void {
  const value = new Function("foo", callbackSource())((callback: () => number) => callback());
  if (value !== 42) throw new Error(`nested callbacks returned ${value}`);
}

function loadAssignmentChain(): void {
  const chain = Array.from({ length: assignmentCount }, (_, index) => `exports.Name${index}`).join(" = ") + " = void 0;";
  const source = "(function(){\n".repeat(assignmentWrapperDepth) + chain + "})();".repeat(assignmentWrapperDepth);
  new Function("exports", source)({});
}

function loadParserInputs(): void {
  loadCallbacks();
  loadAssignmentChain();
}

function recover(): void {
  if ((0, eval)("21 * 2") !== 42) throw new Error("parser did not recover");
}

function run(): void {
  loadParserInputs();
  console.log("nested callbacks and assignments loaded");

  const deep = "(() => ".repeat(200000) + "0" + ")".repeat(200000);
  try {
    (0, eval)(deep);
    throw new Error("deep valid arrow syntax did not overflow");
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    console.log("deep parser overflow caught");
  }
  recover();
  loadParserInputs();
  console.log("nested callbacks and assignments reloaded");
  console.log("continued");
}

if (process.argv[2] === "run") {
  run();
} else {
  const child = spawnSync(process.execPath, [__filename, "run"], {
    env: { ...process.env, ...(quickjs ? { BUN_WASM_STACK_KIB: "32" } : {}) }, encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  if (child.status !== 0) throw new Error(`parser child exited ${child.status}`);
}
