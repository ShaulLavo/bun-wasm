import { createRuntime } from "waffle";
import { loadWasm } from "../src/engine-loader.ts";
import { programKind } from "../../src/engine-kind.ts";
import { startRun } from "../src/runner.ts";
import { retainedMemorySnapshots } from "../src/memory-telemetry.ts";

const runtime = createRuntime({ filesystem: { workerURL: new URL("./fs-worker.js", location.href) } });
let run: ReturnType<typeof startRun> | undefined;
const results: unknown[] = [];
let failure: string | undefined;
try {
  if (new URL(location.href).searchParams.get("engine") !== "hermes") throw new Error("Hermes requires explicit URL opt-in");
  Reflect.set(globalThis, "__bunwasmBuilds", await (await fetch("./engine-builds.json")).json());
  const { module } = await loadWasm("./bun-hermes.wasm", () => {});
  if (programKind(module) !== "hermes") throw new Error("Host did not load the Hermes core");
  await runtime.filesystem.mkdirp("/home/user");
  const files: unknown = await (await fetch("./fixture.json")).json();
  if (!Array.isArray(files)) throw new Error("Missing host fixtures");
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.source !== "string") throw new Error("Invalid host fixture");
    await runtime.filesystem.writeFile(`/home/user/${file.path}`, file.source);
  }
  await runtime.filesystem.flush();
  const paths = new URL(location.href).searchParams.has("metadata") ? ["metadata.mts"] : ["hello.cts", "module.mts"];
  for (const path of paths) {
    let stdout = "", stderr = "";
    const decoder = new TextDecoder();
    run = startRun({ engine: "hermes", module, args: ["run", `/home/user/${path}`], env: { PWD: "/home/user" }, runtime, moduleScope: false }, {
      stdout(bytes) { stdout += decoder.decode(bytes); },
      stderr(bytes) { stderr += decoder.decode(bytes); },
    });
    const outcome = await run.done;
    results.push({ path, outcome, stdout, stderr });
  }
  const memory = await retainedMemorySnapshots();
  Reflect.set(globalThis, "hermesHostMemory", memory);
} catch (error) { failure = String(error); }
finally {
  run?.kill(9);
  await runtime.dispose();
  Reflect.set(globalThis, "hermesHostResult", { engine: "hermes", results, failure, disposed: true });
}
