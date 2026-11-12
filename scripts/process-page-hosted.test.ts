import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { runHostedProcess } from "../web/tests/browser-process-hosted";
import { prepareProcessBundle } from "../web/tests/process-page-assets";

function availablePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try { return probe.port; }
  finally { probe.stop(true); }
}

let output: string | undefined;
let producer: Promise<void> | undefined;
const preparation = new AbortController();
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "bpp-"));
  await Bun.write(join(output, "not-a-directory"), "not a scratch directory");
  producer = prepareProcessBundle(join(output, "bundles/supervisor"), preparation.signal);
  await producer;
}, 30_000);
afterAll(async () => {
  preparation.abort();
  await producer?.catch(() => undefined);
  if (output) await rm(output, { recursive: true, force: true });
});

type Engine = Parameters<typeof runHostedProcess>[0];
type Control = NonNullable<Parameters<typeof runHostedProcess>[3]>;
const controls: readonly { engine: Engine; control: Control; exit: number }[] = [
  { engine: "chromium", control: "delayed-finish", exit: 0 },
  { engine: "webkit", control: "delayed-finish", exit: 0 },
  { engine: "chromium", control: "assertion", exit: 1 },
  { engine: "chromium", control: "late-error", exit: 2 },
];

for (const { engine, control, exit } of controls) {
  test(`page-owned process ${engine} ${control} preserves cases and foreign storage`, async () => {
    if (!output) throw new Error("Process control assets not prepared");
    const resultPath = join(output, `${engine}-${control}.json`);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../web/tests/browser-process-hosted.ts"), engine, "--result", resultPath, control], {
      env: { ...process.env, PROCESS_SMOKE_PORT: String(availablePort()), STORAGE_SCRATCH_ROOT: join(output, "not-a-directory"), BUN_WASM_PROCESS_BUNDLES: join(output, "bundles") },
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, detail: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, detail: "" });
      const result: unknown = await Bun.file(resultPath).json();
      expect(result).toMatchObject({ exit });
    } finally { child.kill("SIGTERM"); await child.exited; }
  }, 180_000);
}
