const inspector = require("node:inspector");

console.log("url", inspector.url() === undefined ? "undefined" : inspector.url());
console.log("close", inspector.close() === undefined ? "undefined" : inspector.close());

for (const [name, invoke] of [
  ["open", () => inspector.open()],
  ["waitForDebugger", () => inspector.waitForDebugger()],
  ["Session", () => new inspector.Session()],
] as const) {
  try {
    invoke();
    console.log(name, "unexpected success");
  } catch (error) {
    console.log(name, error?.code ?? "none", error?.message ?? String(error));
  }
}
