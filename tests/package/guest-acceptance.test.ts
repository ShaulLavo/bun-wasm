import { quickjsPair } from "./quickjs-plan-fixture";
import { appendCustomSection } from "../../src/engine-kind";
import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { acceptGuestPublication, acceptedPublicationArtifact, snapshotPublicationInputs, verifyPublicationInputs, verifyPublicationReport, type PublicationSnapshot } from "../../scripts/guest-acceptance.ts";
import { decodeGuest, describeGuest, prepareGuest } from "../../scripts/guest-artifact.ts";
import { fixtureReceipt, receiptCliSources } from "./guest-receipt-fixture.ts";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const quickjs = quickjsPair();
const jsc = quickjsPair("jsc");
const descriptor = prepareGuest({ kind: "quickjs", ...quickjs }).descriptor;
const names = ["bun.wasm", "bun-jsc.wasm", "bun-browser.wasm"];

async function writeReceipts(dist: string, changed?: Uint8Array): Promise<void> {
  await writeFile(join(dist, "quickjs.wasm"), quickjs.side);
  await writeFile(join(dist, "jsc-engine.wasm"), jsc.side);
  for (const name of names) {
    const build = name === "bun.wasm" ? "quickjs" : name === "bun-jsc.wasm" ? "jsc" : "browser";
    const core = build === "quickjs" ? quickjs.core : build === "jsc" ? jsc.core : wasm;
    if (!changed) await writeFile(join(dist, name), core);
    const receiptCore = changed ? appendCustomSection(core, "changed", changed) : core;
    const side = build === "jsc" ? jsc.side : quickjs.side;
    await writeFile(join(dist, `${name}.build.json`), JSON.stringify(fixtureReceipt(receiptCore, build, side)) + "\n");
  }
}

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
    await writeReceipts(dist);
    await expect(verifyPublicationInputs(dist, descriptor)).resolves.toBeUndefined();
    await expect(verifyPublicationInputs(dist, { ...descriptor, core: { ...descriptor.core, sha256: "0".repeat(64) } })).rejects.toThrow("integrity mismatch");
  });
});

test("publication requires a receipt for every full-build artifact", async () => {
  await fixture(async dist => {
    for (const name of names) await writeFile(join(dist, name), wasm);
    await writeReceipts(dist);
    await rm(join(dist, "bun-jsc.wasm.build.json"));
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow(join(dist, "bun-jsc.wasm.build.json"));
  });
});

test("publication rejects a receipt that does not match its artifact", async () => {
  await fixture(async dist => {
    for (const name of names) await writeFile(join(dist, name), wasm);
    await writeReceipts(dist);
    await writeReceipts(dist, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 1, 0]));
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow("does not match artifact bytes");
  });
});

test("publication verifies later receipts even when the first artifact matches", async () => {
  await fixture(async dist => {
    for (const name of names) await writeFile(join(dist, name), wasm);
    await writeReceipts(dist);
    await writeFile(join(dist, "bun-jsc.wasm.build.json"), "{}\n");
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow("Invalid guest build receipt");
  });
});

test("publication rejects unexpected build receipts", async () => {
  await fixture(async dist => {
    for (const name of names) await writeFile(join(dist, name), wasm);
    await writeReceipts(dist);
    await writeFile(join(dist, "extra.wasm.build.json"), "{}\n");
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow(join(dist, "extra.wasm.build.json"));
  });
});

test("aborted publication cannot launch browser acceptance or upload", async () => {
  await fixture(async dist => {
    for (const name of names) await writeFile(join(dist, name), wasm);
    await writeReceipts(dist);
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
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../../scripts/publish-guest.ts", import.meta.url)),
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

function greenReceipts(snapshot: PublicationSnapshot) {
  return { ok: true, cleanup: { safe: true }, reports: ["chromium", "firefox", "webkit"].map(browser => ({
    browser, ok: true, artifacts: snapshot.artifacts.map(artifact => ({ ...artifact })),
  })) };
}

async function withSnapshot(run: (dist: string, snapshot: PublicationSnapshot) => Promise<void>) {
  await fixture(async dist => {
    for (const name of names) await writeFile(join(dist, name), wasm);
    await writeReceipts(dist);
    const snapshot = await snapshotPublicationInputs(dist, descriptor, join(dist, "snapshot"));
    try { await run(dist, snapshot); }
    finally { await chmod(snapshot.directory, 0o700); }
  });
}

test("publication snapshots are private read-only copies and live rebuilds cannot change upload bytes", async () => {
  await withSnapshot(async (dist, snapshot) => {
    expect((await stat(snapshot.directory)).mode & 0o777).toBe(0o500);
    expect((await stat(join(snapshot.directory, "bun.wasm"))).mode & 0o777).toBe(0o400);
    const rebuilt = new Uint8Array(Array.from(wasm).concat([0, 2, 1, 120]));
    // Simulate the A -> B -> A race from review while the runner owns snapshot A.
    for (const name of names) await writeFile(join(dist, name), rebuilt);
    const loadedB = greenReceipts(snapshot);
    loadedB.reports[0]!.artifacts[0]!.sha256 = describeGuest(rebuilt).sha256;
    expect(() => verifyPublicationReport(snapshot, loadedB)).toThrow("loaded SHA-256");
    for (const name of names) await writeFile(join(dist, name), wasm);
    expect(() => verifyPublicationReport(snapshot, loadedB)).toThrow("loaded SHA-256");
    // Even a second live replacement cannot change the accepted upload source.
    await writeFile(join(dist, "bun.wasm"), rebuilt);
    const artifact = await acceptedPublicationArtifact(snapshot, greenReceipts(snapshot), descriptor);
    expect(artifact.descriptor).toEqual(descriptor);
    expect(decodeGuest(artifact.files.core.gzip)).toEqual(quickjs.core);
    expect(await readFile(join(snapshot.directory, "bun.wasm"))).toEqual(Buffer.from(quickjs.core));
  });
});

test("publication rejects missing, duplicate, wrong-sized or non-green browser receipts", async () => {
  await withSnapshot(async (_dist, snapshot) => {
    const missing = greenReceipts(snapshot); missing.reports.pop();
    expect(() => verifyPublicationReport(snapshot, missing)).toThrow("all publication browsers");
    const duplicate = greenReceipts(snapshot); duplicate.reports[1]!.browser = "chromium";
    expect(() => verifyPublicationReport(snapshot, duplicate)).toThrow("all publication browsers");
    const wrongSize = greenReceipts(snapshot); wrongSize.reports[0]!.artifacts[0]!.bytes++;
    expect(() => verifyPublicationReport(snapshot, wrongSize)).toThrow("loaded byte count");
    const failed = greenReceipts(snapshot); failed.reports[0]!.ok = false;
    expect(() => verifyPublicationReport(snapshot, failed)).toThrow("acceptance passed");
    const unsafe = greenReceipts(snapshot); unsafe.cleanup.safe = false;
    expect(() => verifyPublicationReport(snapshot, unsafe)).toThrow("runner cleanup");
    const noArtifact = greenReceipts(snapshot); noArtifact.reports[0]!.artifacts.pop();
    expect(() => verifyPublicationReport(snapshot, noArtifact)).toThrow("artifact receipt count");
    const duplicateArtifact = greenReceipts(snapshot);
    duplicateArtifact.reports[0]!.artifacts[1]!.name = "bun.wasm";
    expect(() => verifyPublicationReport(snapshot, duplicateArtifact)).toThrow("distinct artifact receipts");
  });
});

test("publication detects changed snapshot bytes even after matching browser receipts", async () => {
  await withSnapshot(async (_dist, snapshot) => {
    const path = join(snapshot.directory, snapshot.selected.name);
    await chmod(path, 0o600);
    await writeFile(path, new Uint8Array(Array.from(wasm).concat([0, 2, 1, 120])));
    await expect(acceptedPublicationArtifact(snapshot, greenReceipts(snapshot), descriptor)).rejects.toThrow("integrity mismatch");
  });
});

test("real CLI resolves its default dist inside a checkout path containing spaces and #", async () => {
  await fixture(async directory => {
    const root = join(directory, "checkout with spaces # encoded"), dist = join(root, "dist");
    await mkdir(join(root, "scripts/src"), { recursive: true }); await mkdir(dist);
    for (const name of ["publish-guest.ts", "guest-acceptance.ts", "guest-artifact.ts"].concat(receiptCliSources)) {
      await copyFile(fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url)), join(root, "scripts", name));
    }
    await mkdir(join(root, "src"));
    await copyFile(new URL("../../src/engine-kind.ts", import.meta.url), join(root, "src/engine-kind.ts"));
    const input = join(dist, "bun.wasm"); await writeFile(input, wasm);
    const child = Bun.spawn([process.execPath, join(root, "scripts/publish-guest.ts"), input, "--account-id", "a".repeat(32)], {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "test-invalid-not-a-credential" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).not.toBe(0);
      expect(stderr).toContain(join(dist, "bun-jsc.wasm"));
      expect(stderr).toContain(join(dist, "bun-browser.wasm"));
    } finally { child.kill(); await child.exited; }
  });
});


test("publication refuses engine relabeling and hash-only historical receipts before acceptance", async () => {
  await fixture(async dist => {
    for (const name of names) await writeFile(join(dist, name), wasm);
    await writeReceipts(dist);
    await writeFile(join(dist, "bun-browser.wasm.build.json"), JSON.stringify(fixtureReceipt(wasm, "quickjs")));
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow("engine mismatch");
    const { sourceManifest: _, sourceManifestSha256: __, ...historical } = fixtureReceipt(wasm, "browser");
    await writeFile(join(dist, "bun-browser.wasm.build.json"), JSON.stringify(historical));
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow("sourceManifestSha256");
  });
});

test("publication snapshots retain the exact source manifest and its checksum", async () => {
  await withSnapshot(async (_dist, snapshot) => {
    const selected = snapshot.selected;
    const receipt = JSON.parse(await readFile(join(snapshot.directory, `${selected.name}.build.json`), "utf8"));
    expect(receipt.sourceManifest).toEqual(selected.receipt.sourceManifest);
    expect(receipt.sourceManifestSha256).toBe(selected.receipt.sourceManifestSha256);
  });
});

test("publication requires the side bytes named by the QuickJS receipt", async () => {
  await fixture(async dist => {
    for (const name of names) await writeFile(join(dist, name), wasm);
    await writeReceipts(dist);
    await rm(join(dist, "quickjs.wasm"));
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow("quickjs.wasm");
    await writeFile(join(dist, "quickjs.wasm"), new Uint8Array(Array.from(quickjs.side).concat([0, 2, 1, 120])));
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow("artifact bytes");
    await writeFile(join(dist, "quickjs.wasm"), quickjs.side);
    const receipt = fixtureReceipt(quickjs.core, "quickjs", quickjs.side);
    await writeFile(join(dist, "bun.wasm.build.json"), JSON.stringify({ ...receipt, program: { kind: "quickjs", core: receipt.program.core } }));
    await expect(verifyPublicationInputs(dist, descriptor)).rejects.toThrow("companion fields");
  });
});

test("publication snapshots and browser receipts bind the actual side bytes", async () => {
  await withSnapshot(async (dist, snapshot) => {
    expect(await readFile(join(snapshot.directory, "quickjs.wasm"))).toEqual(Buffer.from(quickjs.side));
    expect((await stat(join(snapshot.directory, "quickjs.wasm"))).mode & 0o777).toBe(0o400);
    const report = greenReceipts(snapshot);
    const side = report.reports[0]!.artifacts.find(artifact => artifact.name === "quickjs.wasm");
    expect(side).toBeDefined();
    if (!side) throw new Error("Missing side receipt");
    side.sha256 = "0".repeat(64);
    expect(() => verifyPublicationReport(snapshot, report)).toThrow("loaded SHA-256 for quickjs.wasm");
    await writeFile(join(dist, "quickjs.wasm"), new Uint8Array(Array.from(wasm).concat([0, 2, 1, 120])));
    const accepted = await acceptedPublicationArtifact(snapshot, greenReceipts(snapshot), descriptor);
    if (accepted.descriptor.kind === "single" || accepted.files.kind === "single") throw new Error("Expected pair");
    expect(accepted.descriptor.side.sha256).toBe(describeGuest(quickjs.side).sha256);
    expect(decodeGuest(accepted.files.side.gzip)).toEqual(quickjs.side);
    await chmod(join(snapshot.directory, "quickjs.wasm"), 0o600);
    await writeFile(join(snapshot.directory, "quickjs.wasm"), new Uint8Array(Array.from(quickjs.side).concat([0, 2, 1, 120])));
    await expect(acceptedPublicationArtifact(snapshot, greenReceipts(snapshot), descriptor)).rejects.toThrow("artifact bytes");
  });
});
