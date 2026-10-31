import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureReceipt } from "../../tests/package/guest-receipt-fixture.ts";

const entry = resolve(import.meta.dir, "browser-shell-consumer.ts");
const guest = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const receipt = fixtureReceipt(guest, "browser");
const inputs = {
  bunHead: receipt.bunHead, bunTree: receipt.bunTree, sysrootReceiptSha256: receipt.sysrootReceiptSha256,
  sourceManifest: receipt.sourceManifest, sourceManifestSha256: receipt.sourceManifestSha256,
};
async function fixture(action: (directory: string, artifact: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-shell-controls-"));
  const artifact = join(directory, "bun.wasm");
  try {
    await Bun.write(artifact, guest);
    await Bun.write(`${artifact}.build.json`, JSON.stringify(receipt));
    await Bun.write(join(directory, "accepted.json"), JSON.stringify(inputs));
    await action(directory, artifact);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function preflight(directory: string, artifact: string) {
  const child = Bun.spawnSync([process.execPath, entry, "chromium"], { env: {
    ...process.env, SHELL_CONSUMER_GUEST: artifact, SHELL_CONSUMER_EXPECTED_INPUTS: join(directory, "accepted.json"),
    SHELL_CONSUMER_PREFLIGHT_ONLY: "1", SHELL_CONSUMER_SCRATCH: join(directory, "must-not-exist"),
  } });
  return { code: child.exitCode, text: child.stdout.toString() + child.stderr.toString() };
}
test("selected shell-consumer guest checks its receipt before installation or browser startup", async () => {
  await fixture(async (directory, artifact) => {
    const result = preflight(directory, artifact);
    expect(result.code).toBe(0);
    expect(result.text).toContain('"artifactSha256"');
    expect(result.text).not.toContain('"resources"');
    expect(await Bun.file(join(directory, "must-not-exist/package.json")).exists()).toBe(false);
  });
});
test("shell-consumer preflight rejects missing receipt and changed bytes", async () => {
  await fixture(async (directory, artifact) => {
    await Bun.write(artifact, new Uint8Array([1, 2, 3]));
    expect(preflight(directory, artifact).text).toContain("does not match artifact bytes");
    await rm(`${artifact}.build.json`);
    expect(preflight(directory, artifact).code).not.toBe(0);
  });
});
test("shell-consumer preflight rejects wrong accepted source inputs", async () => {
  await fixture(async (directory, artifact) => {
    await Bun.write(join(directory, "accepted.json"), JSON.stringify({ ...inputs, bunHead: "4".repeat(40) }));
    const result = preflight(directory, artifact);
    expect(result.code).not.toBe(0);
    expect(result.text).toContain("accepted guest bunHead");
    expect(result.text).not.toContain('"resources"');
  });
});
