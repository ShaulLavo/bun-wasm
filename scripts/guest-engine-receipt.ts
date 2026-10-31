import { resolve } from "node:path";
import { captureProgramInputs, engineEnvironment, parseProgramInputs, verifyProgramReceipt, writeProgramReceipt } from "./guest-core-receipt.ts";
import { sourceOptions } from "./guest-source-manifest.ts";
import { isPairedEngine } from "../src/engine-kind.ts";
import { parseProgramProfile } from "./src/program-profile.ts";

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (!sysroot) throw new Error("Set BUN_WASM_SYSROOT");
  const [command, path, snapshot] = process.argv.slice(2);
  if ((command === "inputs" || command === "environment") && isPairedEngine(path)) {
    const profile = parseProgramProfile(snapshot);
    if (command === "inputs") console.log(JSON.stringify(await captureProgramInputs(sourceOptions(root, sysroot, path), path, undefined, profile)));
    else {
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      console.log("unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS\n" + Object.entries(engineEnvironment(path, sysroot, profile)).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n"));
    }
  } else if (command === "write" && path && snapshot) await writeProgramReceipt(root, sysroot, path, snapshot);
  else if (command === "verify" && path && snapshot) {
    const expected = parseProgramInputs(await Bun.file(snapshot).json());
    if (expected.scope === "core") throw new Error("Expected engine program inputs");
    verifyProgramReceipt(await Bun.file(path).bytes(), await Bun.file(`${path}.engine.json`).json(), expected);
  } else throw new Error("Usage: guest-engine-receipt.ts inputs quickjs|jsc|hermes [shared-group] | environment quickjs|jsc|hermes [shared-group] | write SIDE SNAPSHOT | verify SIDE SNAPSHOT");
}
