import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGuestBuildInputs, verifyGuestBuildReceipt, writeGuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";

async function fixture(run: (root: string, sysroot: string, artifact: string, git: (...args: string[]) => string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-guest-receipt-"));
  try {
    const vendor = join(root, "vendor/bun"), sysroot = join(root, "sysroot");
    for (const path of [vendor, sysroot, join(root, "scripts"), join(root, "patches/bun")]) await mkdir(path, { recursive: true });
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", vendor].concat(args));
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git("init", "-b", "fixture");
    git("config", "user.name", "Guest receipt fixture");
    git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(vendor, "source.txt"), "pinned source\n");
    git("add", "source.txt");
    git("commit", "-m", "pinned source");
    const script = await readFile(new URL("../../scripts/sync-bun.sh", import.meta.url), "utf8");
    await writeFile(join(root, "scripts/sync-bun.sh"), script.replace(/^BUN_COMMIT=.*$/m, `BUN_COMMIT=${git("rev-parse", "HEAD")}`));
    await writeFile(join(root, "env.sh"), `export TMPDIR=${JSON.stringify(root)}\n`);
    await writeFile(join(sysroot, "bun-wasm-sysroot.json"), '{"fixture":"patched inputs"}\n');
    const artifact = join(root, "guest.wasm");
    await writeFile(artifact, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    await run(root, sysroot, artifact, git);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("guest build receipt records checked Bun source, sysroot receipt and final artifact bytes", async () => {
  await fixture(async (root, sysroot, artifact, git) => {
    const inputs = await prepareGuestBuildInputs(root, sysroot);
    const receipt = await writeGuestBuildReceipt(root, sysroot, artifact, inputs);
    expect(receipt.bunHead).toBe(git("rev-parse", "HEAD"));
    expect(receipt.bunTree).toBe(git("rev-parse", "HEAD^{tree}"));
    expect(receipt.sysrootReceiptSha256).toBe(new Bun.CryptoHasher("sha256").update(await Bun.file(join(sysroot, "bun-wasm-sysroot.json")).bytes()).digest("hex"));
    expect(receipt.artifactBytes).toBe(8);
    expect(await Bun.file(`${artifact}.build.json`).json()).toEqual(receipt);
    const bytes = await Bun.file(artifact).bytes();
    expect(() => verifyGuestBuildReceipt(bytes, receipt)).not.toThrow();
    expect(() => verifyGuestBuildReceipt(bytes, { ...receipt, bunHead: "stale" })).toThrow("bunHead");
    expect(() => verifyGuestBuildReceipt(bytes, { ...receipt, artifactSha256: "0".repeat(64) })).toThrow("does not match");
    expect(() => verifyGuestBuildReceipt(new Uint8Array([1]), receipt)).toThrow("does not match");
  });
});

test("guest build preparation rejects stale imported source without repairing it", async () => {
  await fixture(async (root, sysroot, artifact, git) => {
    await writeFile(join(root, "vendor/bun/source.txt"), "different committed source\n");
    git("commit", "-am", "different source");
    const head = git("rev-parse", "HEAD");
    await expect(prepareGuestBuildInputs(root, sysroot)).rejects.toThrow("differs from the checked-in patch series");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(await Bun.file(`${artifact}.build.json`).exists()).toBe(false);
  });
});

for (const change of ["source", "commit", "sysroot"] as const) test(`guest build cannot acquire a receipt after ${change} changes`, async () => {
  await fixture(async (root, sysroot, artifact, git) => {
    const inputs = await prepareGuestBuildInputs(root, sysroot);
    if (change === "sysroot") await writeFile(join(sysroot, "bun-wasm-sysroot.json"), "changed input receipt\n");
    else {
      await writeFile(join(root, "vendor/bun/source.txt"), "changed during build\n");
      if (change === "commit") git("commit", "-am", "changed during build");
    }
    await expect(writeGuestBuildReceipt(root, sysroot, artifact, inputs)).rejects.toThrow("changed during the build");
    expect(await Bun.file(`${artifact}.build.json`).exists()).toBe(false);
  });
});
