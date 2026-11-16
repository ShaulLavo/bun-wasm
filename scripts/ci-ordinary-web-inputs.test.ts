import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { browserProgramFiles, exportBrowserProgram } from "./ci-browser-program.ts";
import { exportOrdinaryJscProgram, ordinaryJscFiles } from "./ci-ordinary-jsc-program.ts";
import { stageOrdinaryWebInputs, verifyOrdinaryLauncher } from "./ci-ordinary-web-inputs.ts";
import { writeBrowserDeliveryFixture, writeJscDeliveryFixture } from "./fixtures/ordinary-web-delivery.ts";
import { git } from "./guest-source-manifest.ts";
import { needsJsc, needsRust } from "./ci-changes.ts";
import { record } from "./guest-core-receipt.ts";

const root = resolve(import.meta.dir, "..");
const source = { head: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };

async function fixture(action: (inputs: Parameters<typeof stageOrdinaryWebInputs>[0]) => Promise<void>) {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-ordinary-web-"));
  try {
    const raw = join(scratch, "raw"), browser = join(scratch, "browser"), program = join(scratch, "jsc"), launcher = join(scratch, "launcher");
    await writeBrowserDeliveryFixture(raw, source);
    await writeJscDeliveryFixture(raw, source);
    await exportBrowserProgram(raw, browser, source);
    await exportOrdinaryJscProgram(raw, join(raw, "bun-core.wasm.core.json"), program, source);
    mkdirSync(launcher);
    writeFileSync(join(launcher, "source.txt"), `${source.head}\n`);
    writeFileSync(join(launcher, "bun-wasm"), "fixture executable", { mode: 0o644 });
    const directory = join(scratch, "consumer");
    mkdirSync(directory);
    await action({ root, directory, browser, jsc: { program, launcher } });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test("original CLI verifiers admit full deliveries before finite staging and preserve every receipt", async () => {
  await fixture(async inputs => {
    await stageOrdinaryWebInputs(inputs);
    for (const name of browserProgramFiles) expect(readFileSync(join(inputs.directory, "dist", name))).toEqual(readFileSync(join(inputs.browser, name)));
    for (const name of ordinaryJscFiles) expect(readFileSync(join(inputs.directory, "dist", name))).toEqual(readFileSync(join(inputs.jsc!.program, name)));
    expect(lstatSync(join(inputs.jsc!.launcher, "bun-wasm")).mode & 0o111).toBe(0o111);
    expect(existsSync(join(inputs.directory, "dist/source.txt"))).toBe(false);
    expect(existsSync(join(inputs.directory, "dist/delivery.json"))).toBe(false);
  });
});

test("non-JSC staging needs neither JSC delivery nor launcher", async () => {
  await fixture(async inputs => {
    rmSync(inputs.jsc!.program, { recursive: true });
    rmSync(inputs.jsc!.launcher, { recursive: true });
    await stageOrdinaryWebInputs({ ...inputs, jsc: undefined });
    expect(existsSync(join(inputs.directory, "dist/bun-jsc.wasm"))).toBe(false);
    expect(existsSync(join(inputs.directory, "dist/bun.wasm"))).toBe(true);
  });
});

for (const defect of ["source label", "delivery metadata", "missing tools", "QuickJS origin", "JSC source", "launcher source", "missing launcher", "symlink launcher", "existing dist"] as const) {
  test(`rejects ${defect} without overwriting an existing destination`, async () => {
    await fixture(async inputs => {
      const dist = join(inputs.directory, "dist");
      if (defect === "source label") writeFileSync(join(inputs.browser, "source.txt"), "wrong\n");
      if (defect === "delivery metadata") writeFileSync(join(inputs.browser, "delivery.json"), "{}");
      if (defect === "missing tools") rmSync(join(inputs.browser, "bun-tools.wasm"));
      if (defect === "QuickJS origin") writeFileSync(join(inputs.browser, "quickjs.wasm.engine.json"), "{}");
      if (defect === "JSC source") writeFileSync(join(inputs.jsc!.program, "source.txt"), "wrong\n");
      if (defect === "launcher source") writeFileSync(join(inputs.jsc!.launcher, "source.txt"), "wrong\n");
      if (defect === "missing launcher") rmSync(join(inputs.jsc!.launcher, "bun-wasm"));
      if (defect === "symlink launcher") {
        copyFileSync(join(inputs.jsc!.launcher, "bun-wasm"), join(inputs.jsc!.launcher, "target"));
        rmSync(join(inputs.jsc!.launcher, "bun-wasm"));
        symlinkSync("target", join(inputs.jsc!.launcher, "bun-wasm"));
      }
      if (defect === "existing dist") { mkdirSync(dist); writeFileSync(join(dist, "owner"), "preserve"); }
      await expect(stageOrdinaryWebInputs(inputs)).rejects.toThrow();
      if (defect === "existing dist") expect(readFileSync(join(dist, "owner"), "utf8")).toBe("preserve");
      else expect(existsSync(dist)).toBe(false);
    });
  });
}

test("launcher admission restores mode and checks a regular source label", async () => {
  await fixture(async inputs => {
    const launcher = join(inputs.jsc!.launcher, "bun-wasm");
    chmodSync(launcher, 0o600);
    expect(verifyOrdinaryLauncher(inputs.jsc!.launcher, source.head)).toBe(launcher);
    expect(lstatSync(launcher).mode & 0o777).toBe(0o755);
    rmSync(join(inputs.jsc!.launcher, "source.txt"));
    symlinkSync("bun-wasm", join(inputs.jsc!.launcher, "source.txt"));
    expect(() => verifyOrdinaryLauncher(inputs.jsc!.launcher, source.head)).toThrow("regular");
  });
});

test("individually valid JSC and tools deliveries must also share patched Bun and sysroot", async () => {
  await fixture(async inputs => {
    const raw = join(inputs.directory, "mismatched-raw"), program = join(inputs.directory, "mismatched-program");
    await writeJscDeliveryFixture(raw, source);
    const build: unknown = await Bun.file(join(raw, "bun-jsc.wasm.build.json")).json();
    if (!record(build)) throw new Error("Missing build fixture");
    await Bun.write(join(raw, "bun-jsc.wasm.build.json"), JSON.stringify({ ...build, bunHead: "9".repeat(40) }));
    await exportOrdinaryJscProgram(raw, join(raw, "bun-core.wasm.core.json"), program, source);
    await expect(stageOrdinaryWebInputs({ ...inputs, jsc: { program, launcher: inputs.jsc!.launcher } })).rejects.toThrow("JSC/tools patched Bun or sysroot mismatch");
    expect(existsSync(join(inputs.directory, "dist"))).toBe(false);
  });
});

test("consumer helper edits and removals own native and JSC qualification", () => {
  expect(needsRust(["scripts/ci-ordinary-web-inputs.ts"])).toBe(true);
  expect(needsJsc(["scripts/ci-ordinary-web-inputs.ts"])).toBe(true);
});
