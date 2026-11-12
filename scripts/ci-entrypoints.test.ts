import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function scratch(operation: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-cli-entrypoints-"));
  try { await operation(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function importBundle(root: string, entrypoint: string, exported: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint], outdir: root, target: "bun", format: "esm", naming: "run.js",
    external: ["playwright"], define: { __GOALS_ANGULAR_DIAGNOSTIC__: JSON.stringify("throw new Error('Import smoke must not run a diagnostic')") },
  });
  expect(result.success, result.logs.join("\n")).toBe(true);
  const bundle = join(root, "run.js");
  const script = `globalThis.fetch = () => { throw new Error("Network forbidden in import smoke"); };
    process.argv = [process.execPath, ${JSON.stringify(bundle)}];
    const imported = await import(${JSON.stringify(pathToFileURL(bundle).href)});
    console.log(typeof imported[${JSON.stringify(exported)}]);`;
  const run = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 10_000 });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toBe("function\n");
  expect(run.stderr).toBe("");
}

test("the maintained fleet runner bundle imports without executing the downloader CLI", () => scratch(async root => {
  await symlink(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
  await importBundle(root, resolve(import.meta.dir, "goals-matrix/run.ts"), "options");
  const cli = spawnSync(process.execPath, [join(root, "run.js"), "--unknown=fixture"], { encoding: "utf8", timeout: 10_000 });
  expect(cli.status).toBe(1);
  expect(cli.stderr).toContain("Unknown or repeated option --unknown=fixture");
}));

test("a bundled bootstrap import does not execute either CI helper CLI", () => scratch(async root => {
  const entry = join(root, "entry.ts");
  await writeFile(entry, `export { selectNodeRelease } from ${JSON.stringify(resolve(import.meta.dir, "ci-bootstrap-tools.ts"))};`);
  await importBundle(root, entry, "selectNodeRelease");
}));

test.each([process.execPath, "node"])("the downloader CLI runs with fixture bytes under %s", host => scratch(async root => {
  const output = join(root, "download");
  const run = spawnSync(host, [resolve(import.meta.dir, "ci-release-download.ts"), "data:text/plain,fixture%20bytes", output], { encoding: "utf8", timeout: 10_000 });
  expect(run.status, run.stderr).toBe(0);
  expect(await readFile(output, "utf8")).toBe("fixture bytes");
}));
