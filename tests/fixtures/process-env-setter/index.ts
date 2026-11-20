// process.env follows Node's EnvSetter and EnvDefiner, as Bun's JSEnvironmentVariableMap does.
const { Worker } = require("node:worker_threads");
const fs = require("node:fs");

function code(fn) {
  try {
    fn();
    return "no throw";
  } catch (error) {
    return error.code ?? error.constructor.name;
  }
}

process.env.NUMBER = 42;
console.log("assignment coerces", JSON.stringify(process.env.NUMBER));
console.log("symbol assignment", code(() => { process.env[Symbol("key")] = "x"; }));
console.log("symbol define", code(() => Object.defineProperty(process.env, Symbol("key"), { value: "x", configurable: true, writable: true, enumerable: true })));
console.log("accessor define", code(() => Object.defineProperty(process.env, "GETTER", { get() { return "x"; } })));
console.log("define without value", code(() => Object.defineProperty(process.env, "NO_VALUE", { configurable: true, writable: true, enumerable: true })), process.env.NO_VALUE);
console.log("partial define", code(() => Object.defineProperty(process.env, "PARTIAL", { value: "x", configurable: true })), process.env.PARTIAL);
Object.defineProperty(process.env, "DEFINED", { value: 7, configurable: true, writable: true, enumerable: true });
console.log("full define coerces", JSON.stringify(process.env.DEFINED));
process.env[""] = "empty";
Object.defineProperty(process.env, "", { value: "empty", configurable: true, writable: true, enumerable: true });
console.log("empty name ignored", process.env[""], Object.keys(process.env).includes(""));

// A write to an object that inherits from process.env is that object's own.
const child = Object.create(process.env);
child.INHERITED_ONLY = 5;
child.NUMBER = 6;
console.log("inherited write", Object.hasOwn(child, "INHERITED_ONLY"), child.INHERITED_ONLY, child.NUMBER, process.env.INHERITED_ONLY, process.env.NUMBER);

// loadEnvFile fills in only the variables that read undefined; an existing empty value wins.
fs.writeFileSync(".env", "FROM_FILE=file\nEMPTY_WINS=from-file\nNUMBER=from-file\n");
process.env.EMPTY_WINS = "";
process.loadEnvFile();
console.log("loadEnvFile", process.env.FROM_FILE, JSON.stringify(process.env.EMPTY_WINS), process.env.NUMBER);
console.log("loadEnvFile path type", code(() => process.loadEnvFile(5)));
console.log("loadEnvFile missing", code(() => process.loadEnvFile("missing.env")));

// A worker's own process.env keeps the same rules, whatever env it was given.
const worker = new Worker(`
  const out = {};
  process.env.X = 42;
  out.coerced = process.env.X;
  try { process.env[Symbol()] = "v"; out.symbol = "no-throw"; }
  catch (e) { out.symbol = e instanceof TypeError ? "TypeError" : String(e); }
  try { Object.defineProperty(process.env, "G", { get() {} }); out.accessor = "no-throw"; }
  catch (e) { out.accessor = e.code || String(e); }
  out.seeded = process.env.SEEDED;
  require("node:worker_threads").parentPort.postMessage(out);
`, { eval: true, env: { SEEDED: "yes" } });
worker.once("message", message => {
  console.log("worker", JSON.stringify(message));
  worker.terminate();
});
