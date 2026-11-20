// A Node host that creates its executable files and then ends without disposing them.
import { NodeProcessBroker } from "../../scripts/node-spawn.ts";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const broker = new NodeProcessBroker({ module, launch() { throw new Error("no guest starts here"); } });
const bin = broker.preopens["/bin"]!;
process.stdout.write(`${bin.slice(0, -"/bin".length)}\n`);
if (process.argv[2] === "throw") throw new Error("host failed before disposal");
process.exit(Number(process.argv[2] ?? 0));
