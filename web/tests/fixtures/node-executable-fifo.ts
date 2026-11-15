import { createNodeExecutableRegistry } from "../../scripts/node-spawn.ts";

const [root, operation] = process.argv.slice(2);
if (!root || operation !== "check" && operation !== "resolve") throw new Error("Expected root and executable operation");
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const registry = createNodeExecutableRegistry(module, { "/": root });
try {
  await registry[operation]("/fifo");
  throw new Error("FIFO executable was admitted");
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "EACCES") throw error;
}
await registry[operation]("/script");
console.log(JSON.stringify({ code: "EACCES", regular: true }));
