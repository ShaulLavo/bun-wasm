import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acceptGuestPublication, verifyPublicationInputs } from "../../scripts/guest-acceptance.ts";
import { describeGuest } from "../../scripts/guest-artifact.ts";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const descriptor = describeGuest(wasm);
const names = ["bun.wasm", "bun-jsc.wasm", "bun-browser.wasm"];

async function fixture(run: (dist: string) => Promise<void>) {
  const dist = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-publication-inputs-"));
  try { await run(dist); }
  finally { await rm(dist, { recursive: true, force: true }); }
}

test("publication requires all three nonempty builds and names every missing input", async () => {
  await fixture(async dist => {
    for (const name of names) {
      await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow(join(dist, name));
    }
    await writeFile(join(dist, names[0]!), wasm);
    await writeFile(join(dist, names[1]!), new Uint8Array());
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow(join(dist, names[1]!));
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow(join(dist, names[2]!));
  });
});

test("publication verifies the exact upload against a matrix artifact", async () => {
  await fixture(async dist => {
    for (const name of names) await writeFile(join(dist, name), wasm);
    await expect(verifyPublicationInputs(dist, descriptor)).resolves.toBeUndefined();
    await expect(verifyPublicationInputs(dist, { ...descriptor, sha256: "0".repeat(64) })).rejects.toThrow("integrity mismatch");
  });
});

test("aborted publication cannot launch browser acceptance or upload", async () => {
  await fixture(async dist => {
    for (const name of names) await writeFile(join(dist, name), wasm);
    const signal = AbortSignal.abort(new Error("test publication cancelled"));
    await expect(acceptGuestPublication(dist, descriptor, signal)).rejects.toThrow("test publication cancelled");
  });
});

test("publication never silently skips missing full builds", async () => {
  await fixture(async dist => {
    await expect(acceptGuestPublication(dist, descriptor, new AbortController().signal)).rejects.toThrow("requires the full interruption matrix");
  });
});

test("real publication CLI fails closed before storage or descriptor changes when full builds are missing", async () => {
  await fixture(async dist => {
    const input = join(dist, "bun.wasm"), output = join(dist, "descriptor.ts");
    await writeFile(input, wasm); await writeFile(output, "existing descriptor\n");
    const child = Bun.spawn([process.execPath, new URL("../../scripts/publish-guest.ts", import.meta.url).pathname,
      input, "--dist", dist, "--output", output, "--account-id", "a".repeat(32)], {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "test-invalid-not-a-credential" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("Guest publication requires the full interruption matrix");
      expect(stderr).toContain(join(dist, "bun-jsc.wasm"));
      expect(stderr).toContain(join(dist, "bun-browser.wasm"));
      expect(await Bun.file(output).text()).toBe("existing descriptor\n");
    } finally { child.kill(); await child.exited; }
  });
});
