import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { bounded } from "../goals-matrix/bounded";
import { launchProcess } from "./lifecycle-process";
import { scoped, type Transport } from "../goals-matrix/transport";
import { Scope } from "../goals-matrix/scope";

test("scoped observation retains the browser root and rejects sends after closure", async () => {
  let requests = 0;
  const noop = async () => {};
  const transport: Transport = { capabilities: {}, processRoot: process.pid, navigate: noop,
    async evaluate() { requests++; throw new Error("sent"); }, openPreview: noop, useHost: noop, usePreview: noop, closePreview: noop, close: noop };
  const scope = Scope.open(1000);
  const page = scoped(transport, scope);
  try {
    expect(page.processRoot).toBe(process.pid);
    await expect(page.evaluate("0")).rejects.toThrow("sent");
    scope.close();
    expect(() => page.evaluate("0")).toThrow("Scope closed");
    expect(requests).toBe(1);
  } finally { scope.close(); }
});

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

for (const mode of ["timeout", "abort"]) {
  test(`pending preview evaluation ${mode} finalizes polling and closes the transport`, async () => {
    const root = await mkdtemp(join(tmpdir(), "bun-wasm-preview-control-"));
    const driver = join(root, "pending-preview.ts");
    await writeFile(driver, `
import { previewObserverControl } from ${JSON.stringify(resolve(import.meta.dir, "native-observation.ts"))};
const controller = new AbortController();
let closed = false;
const noop = async () => {};
const transport = { capabilities: {}, processRoot: process.pid, navigate: noop, evaluate: () => new Promise(() => {}), openPreview: noop, useHost: noop, usePreview: noop, closePreview: noop, close: async () => { closed = true; } };
if (${JSON.stringify(mode)} === "abort") setTimeout(() => controller.abort(new Error("Preview control cancelled")), 100);
const valid = await previewObserverControl(transport, process.argv[2], 200, controller.signal);
console.log(JSON.stringify({ valid, closed, aborted: controller.signal.aborted }));
`);
    const job = launchProcess([process.execPath, driver, root], root, process.env, root);
    try {
      expect(await bounded(() => job.exited, 3000)).toBe(0);
      expect(JSON.parse(await readFile(join(root, "stdout.txt"), "utf8"))).toEqual({ valid: false, closed: true, aborted: mode === "abort" });
      expect(JSON.parse(await readFile(join(root, "preview-observer-control.json"), "utf8")).kind).toBe("proc-polling");
      const failure = JSON.parse(await readFile(join(root, "preview-control-error.json"), "utf8"));
      expect(failure.close.closed).toBe(true);
      expect(failure.aborted).toBe(mode === "abort");
      expect(failure.unavailable).toContain(mode === "abort" ? "Preview control cancelled" : "timed out");
    } finally { await job.close(); await rm(root, { recursive: true, force: true }); }
  }, 10000);
}
