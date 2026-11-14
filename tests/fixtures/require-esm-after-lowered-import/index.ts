globalThis.order = [];
globalThis.sharedRuns = 0;

async function main() {
  const lowered = new Function("s", "return import(s)") as (specifier: string) => Promise<object>;
  const pending = lowered("./p.mjs");
  require("./r.mjs");
  await pending;
  console.log("order", (globalThis.order as string[]).join(","));
  console.log("d runs", globalThis.sharedRuns);
  console.log("same", await import("./d.mjs") === require("./d.mjs"));
}

main().catch(error => { throw error; });
