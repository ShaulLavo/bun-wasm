globalThis.order = [];
globalThis.sharedRuns = 0;

async function main() {
  const lowered = new Function("s", "return import(s)") as (specifier: string) => Promise<object>;
  const pending = lowered("./p.mts");
  require("./r.mts");
  await pending;
  console.log("order", (globalThis.order as string[]).join(","));
  console.log("d runs", globalThis.sharedRuns);
  console.log("same", await import("./d.mts") === require("./d.mts"));
}

main().catch(error => { throw error; });
