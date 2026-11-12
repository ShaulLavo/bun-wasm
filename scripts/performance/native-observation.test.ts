import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { bounded } from "../goals-matrix/bounded";
import { launchProcess } from "./lifecycle-process";

test("failed native controls stop polling and exit without an external deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-observer-failure-"));
  const driver = join(root, "failed-control.ts");
  const module = resolve(import.meta.dir, "native-observation.ts");
  await writeFile(driver, `#!${process.execPath}
import { nativeObserverControls } from ${JSON.stringify(module)};
if (process.argv[2]?.endsWith("sharing-startup.ts")) {
  await Bun.sleep(400);
  process.exit(3);
}
const valid = await nativeObserverControls(import.meta.path, process.argv[2], process.env, process.argv[2], new AbortController().signal);
if (valid) throw new Error("Failing control was accepted");
console.log("CONTROL_REJECTED");
`);
  await chmod(driver, 0o700);
  const job = launchProcess([process.execPath, driver, root], root, process.env, root);
  try {
    const code = await bounded(() => job.exited, 4000);
    expect(code).toBe(0);
    expect(await readFile(join(root, "stdout.txt"), "utf8")).toContain("CONTROL_REJECTED");
    for (const mode of ["leaf", "root"]) {
      const observation = JSON.parse(await readFile(join(root, `control-native-${mode}`, "observation.json"), "utf8"));
      expect(observation.kind).toBe("proc-polling");
      const controls = JSON.parse(await readFile(join(root, "native-observer-controls.json"), "utf8"));
      expect(controls.every((control: { reason: string | null }) => control.reason === "Error: Native root/child control output missing")).toBe(true);
    }
  } finally { await job.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);
