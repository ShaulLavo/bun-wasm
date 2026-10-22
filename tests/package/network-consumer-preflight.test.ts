import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GuestBuildInputs, GuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";

const gate = fileURLToPath(new URL("../../web/tests/browser-network-consumer.ts", import.meta.url));
const guest = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const inputs: GuestBuildInputs = {
  bunHead: "a".repeat(40), bunTree: "b".repeat(40), sysrootReceiptSha256: "c".repeat(64),
};
const receipt: GuestBuildReceipt = {
  ...inputs,
  artifactSha256: new Bun.CryptoHasher("sha256").update(guest).digest("hex"),
  artifactBytes: guest.byteLength,
};

async function fixture(check: (root: string, artifact: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-network-preflight-"));
  try {
    const artifact = join(root, "guest.wasm");
    await writeFile(artifact, guest);
    await writeFile(`${artifact}.build.json`, JSON.stringify(receipt));
    await writeFile(join(root, "accepted-inputs.json"), JSON.stringify(inputs));
    await check(root, artifact);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function preflight(root: string, env: NodeJS.ProcessEnv = {}) {
  const before = (await readdir(root)).sort();
  const child = Bun.spawn([process.execPath, gate, "chromium"], {
    env: {
      ...process.env,
      NETWORK_CONSUMER_GUEST: join(root, "guest.wasm"),
      NETWORK_CONSUMER_EXPECTED_INPUTS: join(root, "accepted-inputs.json"),
      NETWORK_CONSUMER_PREFLIGHT_ONLY: "1",
      NETWORK_CONSUMER_SCRATCH: root,
      NETWORK_CONSUMER_PORT: "0",
      PLAYWRIGHT_BROWSERS_PATH: join(root, "no-browser-cache"),
      ...env,
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
  });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect((await readdir(root)).sort()).toEqual(before);
    return { code, stdout, stderr };
  } finally { child.kill(); await child.exited; }
}

test("network preflight accepts a matching receipt and selected build inputs without browser setup", async () => {
  await fixture(async (root, artifact) => {
    const result = await preflight(root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ready: true,
      artifact: { path: artifact, receipt, expectedInputs: join(root, "accepted-inputs.json") },
      acceptance: "pending browser execution",
    });
  });
});

test("network preflight rejects a missing build receipt before browser setup", async () => {
  await fixture(async (root, artifact) => {
    await rm(`${artifact}.build.json`);
    const result = await preflight(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`${artifact}.build.json`);
  });
});

test("network preflight rejects changed artifact bytes before browser setup", async () => {
  await fixture(async (root, artifact) => {
    await writeFile(artifact, new Uint8Array([0, 97, 115, 109, 2, 0, 0, 0]));
    const result = await preflight(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not match artifact bytes");
  });
});

for (const field of ["bunHead", "bunTree", "sysrootReceiptSha256"] as const) {
  test(`network preflight rejects wrong selected ${field} before browser setup`, async () => {
    await fixture(async root => {
      await writeFile(join(root, "accepted-inputs.json"), JSON.stringify({ ...inputs, [field]: "d".repeat(inputs[field].length) }));
      const result = await preflight(root);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`matches accepted ${field}`);
    });
  });
}

test("network preflight requires independently selected build inputs", async () => {
  await fixture(async root => {
    const result = await preflight(root, { NETWORK_CONSUMER_EXPECTED_INPUTS: "" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("NETWORK_CONSUMER_EXPECTED_INPUTS must be an absolute");
  });
});

for (const value of [null, [], {}, { ...inputs, bunHead: "invalid" }]) {
  test(`network preflight rejects malformed selected inputs ${JSON.stringify(value)}`, async () => {
    await fixture(async root => {
      await writeFile(join(root, "accepted-inputs.json"), JSON.stringify(value));
      const result = await preflight(root);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("accepted");
    });
  });
}

test("network preflight rejects a malformed build receipt before browser setup", async () => {
  await fixture(async (root, artifact) => {
    await writeFile(`${artifact}.build.json`, JSON.stringify({ ...receipt, bunHead: "invalid" }));
    const result = await preflight(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Invalid guest build receipt: bunHead");
  });
});
