import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixture, installFixtureTargets, type InstallFixtureTarget } from "./install-fixture-command";
import { createRegistry } from "../tests/install/registry.mjs";

function install(target: InstallFixtureTarget, directory: string, registry: string, args: string[] = [], expected = 0) {
  return installFixture(directory, registry, args, expected, true, [], target);
}

function installedVersion(directory: string, relativePath: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(directory, "node_modules", relativePath, "package.json"), "utf8"));
  assert.ok(manifest && typeof manifest === "object" && "version" in manifest && typeof manifest.version === "string");
  return manifest.version;
}

async function workspaceCatalogsRoundtrip(target: InstallFixtureTarget) {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-catalog-e2e-"));
  const registry = await createRegistry();
  try {
    mkdirSync(join(directory, "packages/app"), { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name: "catalog-root",
      dependencies: { versioned: "1.0.0" },
      workspaces: {
        packages: ["packages/*"],
        catalog: { "is-number": "7.0.0", versioned: "latest" },
        catalogs: { extra: { "is-odd": "3.0.1" } },
      },
    }, null, 2));
    writeFileSync(join(directory, "packages/app/package.json"), JSON.stringify({
      name: "@fixture/app",
      version: "1.0.0",
      dependencies: { "is-number": "catalog: ", "is-odd": "catalog:extra", versioned: "catalog:" },
    }, null, 2));
    registry.latest.set("versioned", "2.0.0");

    await install(target, directory, registry.base);
    assert.equal(installedVersion(directory, "is-number"), "7.0.0");
    assert.equal(installedVersion(directory, "is-odd"), "3.0.1");
    assert.equal(installedVersion(directory, "versioned"), "1.0.0");
    assert.equal(installedVersion(directory, "@fixture/app/node_modules/versioned"), "2.0.0");
    const lock = readFileSync(join(directory, "bun.lock"), "utf8");
    assert.match(lock, /"catalog":/);
    assert.match(lock, /"catalogs":/);

    rmSync(join(directory, "node_modules"), { recursive: true, force: true });
    registry.setOffline(true);
    await install(target, directory, registry.base, ["--frozen-lockfile"]);
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock);
    assert.equal(installedVersion(directory, "@fixture/app/node_modules/versioned"), "2.0.0");
    await install(target, directory, registry.base);
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock);
    assert.equal(installedVersion(directory, "@fixture/app/node_modules/versioned"), "2.0.0");
  } finally {
    await registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function missingCatalogAndFetchErrorContext(target: InstallFixtureTarget) {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-catalog-err-"));
  const closed = createServer();
  try {
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
    const address = closed.address();
    assert.ok(address && typeof address === "object");
    const deadPort = address.port;
    await new Promise<void>(resolve => closed.close(() => resolve()));

    const missingDir = join(directory, "missing-catalog");
    mkdirSync(join(missingDir, "packages/app"), { recursive: true });
    writeFileSync(join(missingDir, "package.json"), JSON.stringify({
      name: "missing-root",
      workspaces: { packages: ["packages/*"], catalog: { "is-number": "7.0.0" } },
    }));
    writeFileSync(join(missingDir, "packages/app/package.json"), JSON.stringify({
      name: "@fixture/missing",
      version: "1.0.0",
      dependencies: { "is-number": "catalog:nope" },
    }));
    const missingOutput = await install(target, missingDir, `http://127.0.0.1:${deadPort}`, [], 1);
    assert.match(missingOutput, /catalog:nope/);
    assert.match(missingOutput, /"nope"/);

    const fetchDir = join(directory, "fetch-error");
    mkdirSync(fetchDir, { recursive: true });
    const tarballUrl = `http://127.0.0.1:${deadPort}/releases/waffle-base-0.0.23.tgz`;
    writeFileSync(join(fetchDir, "package.json"), JSON.stringify({
      name: "fetch-error-root",
      dependencies: { "waffle-base": tarballUrl },
    }));
    const fetchOutput = await install(target, fetchDir, `http://127.0.0.1:${deadPort}`, [], 1);
    assert.ok(fetchOutput.includes("waffle-base"), `expected package specifier in output:\n${fetchOutput}`);
    assert.ok(fetchOutput.includes(tarballUrl), `expected failing URL in output:\n${fetchOutput}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const target of installFixtureTargets()) {
  test(`workspace catalogs and dist-tag lock replay work end-to-end (${target.engine})`, () => workspaceCatalogsRoundtrip(target), 120000);
  test(`missing catalog and failed tarball fetch report actionable diagnostics (${target.engine})`, () => missingCatalogAndFetchErrorContext(target), 120000);
}
