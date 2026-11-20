import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserProgramFiles } from "./ci-browser-program.ts";
import { ordinaryJscFiles } from "./ci-ordinary-jsc-program.ts";
import { git } from "./guest-source-manifest.ts";
import { prepareWebGuestFixtures } from "./test-web-guests.ts";
import { verifyGuestBuildReceipt } from "./guest-build-receipt.ts";

type Inputs = {
  root: string;
  directory: string;
  browser: string;
  jsc?: { program: string; launcher: string };
};

export function verifyOrdinaryLauncher(directory: string, head: string): string {
  const launcher = join(directory, "bun-wasm");
  assert(lstatSync(launcher).isFile(), "Native launcher must be a regular file");
  assert(lstatSync(join(directory, "source.txt")).isFile(), "Native launcher source must be a regular file");
  assert.equal(readFileSync(join(directory, "source.txt"), "utf8"), `${head}\n`, "Native launcher source mismatch");
  chmodSync(launcher, 0o755);
  accessSync(launcher, constants.X_OK);
  return launcher;
}

function programInputs(directory: string, name: string) {
  const receipt: unknown = JSON.parse(readFileSync(join(directory, `${name}.build.json`), "utf8"));
  verifyGuestBuildReceipt(readFileSync(join(directory, name)), receipt);
  return { bunHead: receipt.bunHead, bunTree: receipt.bunTree, sysrootReceiptSha256: receipt.sysrootReceiptSha256 };
}

export async function stageOrdinaryWebInputs({ root, directory, browser, jsc }: Inputs): Promise<void> {
  const verify = (script: string, directory: string) => execFileSync(process.execPath, [join(root, "scripts", script), "verify", directory], { cwd: root, stdio: "inherit" });
  verify("ci-browser-program.ts", browser);
  if (jsc) {
    verify("ci-ordinary-jsc-program.ts", jsc.program);
    verifyOrdinaryLauncher(jsc.launcher, git(root, "rev-parse", "HEAD"));
    assert.deepEqual(programInputs(browser, "bun-tools.wasm"), programInputs(jsc.program, "bun-jsc.wasm"), "JSC/tools patched Bun or sysroot mismatch");
  }
  let files: { name: string; from: string }[] = browserProgramFiles.map(name => ({ name, from: browser }));
  if (jsc) files = files.concat(ordinaryJscFiles.map(name => ({ name, from: jsc.program })));
  assert.equal(new Set(files.map(file => file.name)).size, files.length, "Ordinary delivery filename collision");
  const dist = join(directory, "dist");
  mkdirSync(dist);
  try {
    for (const file of files) copyFileSync(join(file.from, file.name), join(dist, file.name), constants.COPYFILE_EXCL);
    for (const engine of jsc ? ["quickjs", "browser", "jsc"] as const : ["quickjs", "browser"] as const) await prepareWebGuestFixtures(directory, engine);
  } catch (error) {
    rmSync(dist, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [browser, selected, program, launcher, ...extra] = process.argv.slice(2);
  assert(browser && extra.length === 0 && (selected === "true" || selected === "false"), "Usage: ci-ordinary-web-inputs.ts BROWSER true JSC LAUNCHER | BROWSER false");
  assert(selected === "true" ? program && launcher : !program && !launcher, "Selected JSC requires exactly its program and launcher");
  const root = resolve(import.meta.dir, "..");
  const jsc = selected === "true" ? { program: resolve(program!), launcher: resolve(launcher!) } : undefined;
  await stageOrdinaryWebInputs({ root, directory: root, browser: resolve(browser), jsc });
}
