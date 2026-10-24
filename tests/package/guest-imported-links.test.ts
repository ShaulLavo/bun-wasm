import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fixtureGit, receiptCli, withCliReceiptFixture } from "./guest-receipt-fixture.ts";

type Fixture = Parameters<typeof receiptCli>[0];
async function commitImport(fixture: Fixture) {
  const vendor = join(fixture.root, "vendor/bun");
  fixtureGit(vendor, "add", "src");
  fixtureGit(vendor, "commit", "-m", "synthetic committed imported links");
  const script = join(fixture.root, "scripts/sync-bun.sh");
  const source = await readFile(script, "utf8");
  await writeFile(script, source.replace(/^BUN_COMMIT=.*$/m, `BUN_COMMIT=${fixtureGit(vendor, "rev-parse", "HEAD")}`));
  fixtureGit(fixture.root, "add", "scripts/sync-bun.sh");
  fixtureGit(fixture.root, "commit", "-m", "synthetic pinned import");
}
async function documentLink(fixture: Fixture, target = "CLAUDE.md") {
  const vendor = join(fixture.root, "vendor/bun");
  await writeFile(join(vendor, "src/CLAUDE.md"), "original imported documentation\n");
  await writeFile(join(vendor, "src/alternate.md"), "alternate imported documentation\n");
  await symlink(target, join(vendor, "src/AGENTS.md"));
  await commitImport(fixture);
  return vendor;
}

for (const [path, target] of [["src/AGENTS.md", "CLAUDE.md"], ["src/cli", "runtime/cli"], ["src/js/AGENTS.md", "CLAUDE.md"]] satisfies [string, string][]) {
  test(`qualified CLI accepts the committed upstream link shape ${path}`, async () => {
    await withCliReceiptFixture(async fixture => {
      const vendor = join(fixture.root, "vendor/bun");
      const link = join(vendor, path);
      const consumed = path === "src/cli" ? join(dirname(link), target, "fixture.rs") : join(dirname(link), target);
      await mkdir(dirname(consumed), { recursive: true });
      await writeFile(consumed, "committed imported fixture\n");
      await symlink(target, link);
      await commitImport(fixture);
      const started = receiptCli(fixture, "inputs", "browser");
      expect(started.stderr.toString()).toBe("");
      expect(started.exitCode).toBe(0);
      const inputs = join(fixture.root, "dist/inputs.json");
      await writeFile(inputs, started.stdout);
      expect(receiptCli(fixture, "write", fixture.artifact, inputs).exitCode).toBe(0);
    });
  });
}

test("hidden committed-link retargeting is rejected without changing the index", async () => {
  await withCliReceiptFixture(async fixture => {
    const vendor = await documentLink(fixture);
    fixtureGit(vendor, "update-index", "--assume-unchanged", "src/AGENTS.md");
    const index = await readFile(join(vendor, ".git/index"));
    await unlink(join(vendor, "src/AGENTS.md"));
    await symlink("alternate.md", join(vendor, "src/AGENTS.md"));
    const result = receiptCli(fixture, "inputs", "browser");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("differs from committed source");
    expect(await readFile(join(vendor, ".git/index"))).toEqual(index);
  });
});

test("hidden changes to a committed link target are rejected", async () => {
  await withCliReceiptFixture(async fixture => {
    const vendor = await documentLink(fixture);
    fixtureGit(vendor, "update-index", "--assume-unchanged", "src/CLAUDE.md");
    await writeFile(join(vendor, "src/CLAUDE.md"), "changed hidden target\n");
    const result = receiptCli(fixture, "inputs", "browser");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("differs from committed source");
  });
});

test("committed imported links cannot escape the imported repository", async () => {
  await withCliReceiptFixture(async fixture => {
    const external = join(fixture.root, "private/external.txt");
    await writeFile(external, "not committed imported source\n");
    await documentLink(fixture, external);
    const result = receiptCli(fixture, "inputs", "browser");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("escapes imported repository");
  });
});

test("a committed imported symlink cannot silently become a regular file", async () => {
  await withCliReceiptFixture(async fixture => {
    const vendor = await documentLink(fixture);
    fixtureGit(vendor, "update-index", "--assume-unchanged", "src/AGENTS.md");
    await unlink(join(vendor, "src/AGENTS.md"));
    await writeFile(join(vendor, "src/AGENTS.md"), "CLAUDE.md");
    const result = receiptCli(fixture, "inputs", "browser");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Unsupported symlink");
  });
});

test("the primary repository source group still rejects committed symlinks", async () => {
  await withCliReceiptFixture(async fixture => {
    await symlink("guest-build-receipt.ts", join(fixture.root, "scripts/receipt-link.ts"));
    fixtureGit(fixture.root, "add", "scripts/receipt-link.ts");
    fixtureGit(fixture.root, "commit", "-m", "synthetic primary repository link");
    const result = receiptCli(fixture, "inputs", "browser");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Unsupported symlink");
  });
});
