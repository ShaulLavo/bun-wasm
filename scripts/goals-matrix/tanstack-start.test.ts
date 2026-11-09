import { expect, test } from "bun:test";
import { frameworks } from "./catalog";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("TanStack Start hydrates at its server root on the selected free port", () => {
  const framework = frameworks.find(item => item.id === "tanstack-start");
  expect(framework?.rootPreview).toEqual({
    dev: "bun run dev --port {port}",
    start: "PORT={port} bun run start",
  });
});

test("TanStack Start opens root-origin previews for every engine", async () => {
  const { playgroundURL } = await import("./run");
  const framework = frameworks.find(item => item.id === "tanstack-start");
  if (!framework) throw new Error("Missing TanStack Start framework");
  for (const engine of ["browser", "quickjs", "jsc"] as const) {
    const url = new URL(playgroundURL("http://127.0.0.1:4567/", framework, engine));
    expect(url.searchParams.has("root-previews")).toBe(true);
    expect(url.searchParams.get("engine")).toBe(engine);
  }
});

async function launcherPort(port?: string): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-tanstack-port-"));
  try {
    await mkdir(join(directory, ".output/server"), { recursive: true });
    await writeFile(join(directory, "start.ts"), await readFile(join(import.meta.dir, "../../sandbox/template-tanstack-start/start.ts")));
    await writeFile(join(directory, ".output/server/index.mjs"), "console.log(JSON.stringify({ port: process.env.PORT, nitroPort: process.env.NITRO_PORT }));");
    const env = { ...process.env };
    delete env.PORT;
    if (port !== undefined) env.PORT = port;
    const child = Bun.spawn([process.execPath, "run", "start.ts", "5173"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("TanStack Start production launcher keeps its default port", async () => {
  expect(await launcherPort()).toEqual({ port: "5173", nitroPort: "5173" });
});

test("TanStack Start production launcher honors an explicit PORT", async () => {
  expect(await launcherPort("41385")).toEqual({ port: "41385", nitroPort: "41385" });
});
