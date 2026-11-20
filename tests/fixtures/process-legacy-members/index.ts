// Node's private and legacy process members, as Bun provides them.
const stubs = ["_debugEnd", "_debugProcess", "_linkedBinding", "_startProfilerIdleNotifier", "_stopProfilerIdleNotifier", "_tickCallback"];
console.log("undefined stubs", stubs.every(name => typeof process[name] === "function" && process[name]() === undefined));
console.log("array stubs", ["_getActiveRequests", "_getActiveHandles", "getActiveResourcesInfo"].map(name => Array.isArray(process[name]())).join(","));
console.log("empty arrays", ["moduleLoadList", "_preload_modules"].map(name => JSON.stringify(process[name])).join(","));

const flags = process.allowedNodeEnvironmentFlags;
console.log("flags set", flags instanceof Set, flags.size > 0, Object.isFrozen(flags), Object.isFrozen(Object.getPrototypeOf(flags)));
console.log("flags has", ["--require", "require", "--no_warnings", "--require=./foo.js", "-r", "r", "--not-a-real-flag", 7].map(flag => flags.has(flag)).join(","));
flags.add("--not-a-real-flag");
console.log("flags immutable", flags.has("--not-a-real-flag"), flags.delete("--require"), flags.has("--require"));
console.log("flags iterate", Array.from(flags).length === flags.size, [...flags.keys()][0]);

const { variables } = process.config;
console.log("config", Object.isFrozen(process.config), typeof variables.clang, variables.node_without_node_options, typeof variables.host_arch, variables.host_arch === variables.target_arch);

function binding(name) {
  try {
    return typeof process.binding(name);
  } catch (error) {
    return error.message.replace(/ If that breaks.*| Track the status.*/, "");
  }
}
for (const name of ["async_wrap", "buffer", "config", "constants", "crypto", "crypto/x509", "fs", "http_parser", "natives", "stream_wrap", "tty_wrap", "util", "uv", "v8", "nope", "", 10, null]) {
  console.log("binding", JSON.stringify(name), binding(name));
}
try {
  process.binding(Symbol("name"));
} catch (error) {
  console.log("binding symbol", error.constructor.name);
}
const buffer = process.binding("buffer");
console.log("buffer binding", typeof buffer.kMaxLength, typeof buffer.compare, process.binding("buffer") === buffer);
try {
  buffer.compare();
} catch (error) {
  console.log(error.message.replace(/ If that breaks.*/, ""));
}
console.log("config binding", JSON.stringify(Object.keys(process.binding("config"))));
const parser = process.binding("http_parser");
console.log("http methods", parser.methods.length, parser.allMethods.length, parser.methods.includes("M-SEARCH"), parser.allMethods.includes("TEARDOWN"));
console.log("natives", typeof process.binding("natives").fs, typeof process.binding("natives")["node:fs"]);
console.log("util types", typeof process.binding("util").isPromise);
console.log("fs stat values", process.binding("fs").statValues.length, process.binding("fs").kFsStatsFieldsNumber);
