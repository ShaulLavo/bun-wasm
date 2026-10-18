import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";

test("Vite emits the exported worker URL without demo code or a second Runtime owner", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-package-vite-"));
  try {
    await build({
      configFile: false,
      root: join(import.meta.dir, "fixtures"),
      logLevel: "error",
      worker: { format: "es" },
      build: { outDir: scratch, emptyOutDir: true, minify: false,
        rolldownOptions: { input: join(import.meta.dir, "fixtures/vite-main.ts"), treeshake: false },
      },
    });
    const files = await readdir(join(scratch, "assets"));
    const worker = files.find(name => name.startsWith("worker-entry-") && name.endsWith(".js"));
    expect(worker).toBeDefined();
    const entry = files.find(name => name.startsWith("vite-main-") && name.endsWith(".js"))!;
    const page = await readFile(join(scratch, "assets", entry), "utf8");
    const source = await readFile(join(scratch, "assets", worker!), "utf8");
    expect(page).toContain(worker!);
    expect(source).toContain("onmessage");
    expect(source).not.toContain("codemirror");
    expect(source).not.toContain("waffle.runtime.owner");
    expect(page).not.toContain("waffle.runtime.owner");
    expect(page).not.toContain("SubprocessBroker");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 30_000);
