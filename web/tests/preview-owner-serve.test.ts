import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function serving(enabled: boolean, run: (origin: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-serve-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await Bun.write(join(directory, "index.html"), "<!doctype html><p>serving fixture</p>");
    const process = Bun.spawn([Bun.which("bun") ?? "bun", join(import.meta.dir, "../serve.ts")], {
      env: { ...globalThis.process.env, ROOT: directory, PORT: "0", HOST: "127.0.0.1", PREVIEW_ORIGINS: enabled ? "1" : "0" },
      stdout: "pipe", stderr: "inherit",
    });
    child = process;
    const reader = process.stdout.getReader();
    const started = async () => {
      let output = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Serving fixture exited before startup");
        output += new TextDecoder().decode(chunk.value);
        const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
        if (origin) return origin;
      }
    };
    const origin = await Promise.race([started(), process.exited.then(() => { throw new Error("Serving fixture exited"); })]);
    await run(origin);
    process.kill("SIGTERM");
    expect(await process.exited).toBe(0);
    reader.releaseLock();
    await expect(fetch(origin)).rejects.toThrow();
  } finally {
    child?.kill("SIGKILL");
    await child?.exited;
    await rm(directory, { recursive: true, force: true });
  }
}

test("Bun serve enables the authenticated owner endpoint without changing static isolation", async () => {
  await serving(true, async origin => {
    const response = await fetch(origin);
    expect(await response.text()).toContain("serving fixture");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    const denied = await fetch(`${origin}/__bun_preview_owner/bootstrap`, { method: "POST" });
    expect(denied.status).toBe(403);
    const allowed = await fetch(`${origin}/__bun_preview_owner/bootstrap`, { method: "POST", headers: { origin } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("set-cookie")).toBeNull();
  });
});

test("Bun serve keeps owner control disabled without explicit root-preview setup", async () => {
  await serving(false, async origin => {
    expect((await fetch(`${origin}/__bun_preview_owner/bootstrap`, { method: "POST", headers: { origin } })).status).toBe(404);
  });
});
