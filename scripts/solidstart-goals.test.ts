import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { frameworks } from "./goals-matrix/catalog";
import { playgroundURL } from "./goals-matrix/run";

test("SolidStart acceptance keeps the browser router at the server's root path", () => {
  const framework = frameworks.find(item => item.id === "solidstart");
  if (!framework) throw new Error("Missing SolidStart template");
  const url = new URL(playgroundURL("http://127.0.0.1:4173/", framework, "browser"));
  expect(url.searchParams.has("root-previews")).toBe(true);
  expect(url.searchParams.get("template")).toBe("solidstart");
  expect(url.searchParams.get("engine")).toBe("browser");
  expect(url.searchParams.get("mode")).toBe("memory");
  expect(framework.rootPreview?.dev.replaceAll("{port}", "41821")).toBe("bun run dev --port 41821");
  expect(framework.rootPreview?.start.replaceAll("{port}", "41821")).toBe("bun run start --port 41821");
});

for (const command of ["dev", "start"]) {
  test(`SolidStart ${command} accepts exactly one allocated port`, async () => {
    const template: unknown = await Bun.file(new URL("../sandbox/template-solidstart/package.json", import.meta.url)).json();
    if (!template || typeof template !== "object" || !("scripts" in template)) throw new Error("Missing template scripts");
    const scripts = template.scripts;
    if (!scripts || typeof scripts !== "object" || !(command in scripts)) throw new Error(`Missing ${command} script`);
    const script: unknown = Reflect.get(scripts, command);
    if (typeof script !== "string") throw new Error(`Invalid ${command} script`);
    const combined = `${script} --port 41821`;
    expect(combined.match(/--port\b/g)).toHaveLength(1);
    expect(combined).toContain("--port 41821");
  });
}

for (const command of ["dev", "build"]) {
  test(`SolidStart ${command} initializes real esbuild in its non-worker mode`, async () => {
    const require = createRequire(import.meta.url);
    const esbuild = require.resolve("esbuild", { paths: [dirname(require.resolve("wrangler/package.json"))] });
    const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-solid-esbuild-"));
    try {
      await writeFile(join(scratch, "package.json"), await Bun.file(new URL("../sandbox/template-solidstart/package.json", import.meta.url)).text());
      await mkdir(join(scratch, "node_modules/vinxi/bin"), { recursive: true });
      await writeFile(join(scratch, "node_modules/vinxi/bin/cli.mjs"), `
        import { createRequire } from "node:module";
        const esbuild = createRequire(import.meta.url)(${JSON.stringify(esbuild)});
        const result = esbuild.transformSync("const value: number = 42", { loader: "ts" });
        console.log(JSON.stringify({ mode: process.env.ESBUILD_WORKER_THREADS ?? null, code: result.code, version: esbuild.version }));
        esbuild.stop();
      `);
      const child = Bun.spawn([process.execPath, "run", command], { cwd: scratch, env: { ...process.env, ESBUILD_WORKER_THREADS: "1" }, stdout: "pipe", stderr: "pipe" });
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });
        expect(stdout).toContain('"mode":"0"');
        expect(stdout).toContain('"code":"const value = 42;\\n"');
      } finally { child.kill(); await child.exited; }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
}
