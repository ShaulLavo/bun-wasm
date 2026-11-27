import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixture, installFixtureCommand, installFixtureTargets, type InstallFixtureTarget } from "./install-fixture-command";
import { createRegistry, packageFixture } from "../tests/install/registry.mjs";

function install(target: InstallFixtureTarget, directory: string, registry: string, args: string[] = [], expected = 0) {
  return installFixture(directory, registry, args, expected, true, [], target);
}

async function runGuestUpdate(target: InstallFixtureTarget, directory: string, registry: string, args: string[]) {
  const [program, argv] = installFixtureCommand(directory, registry, args, true, [], target);
  const cmdIndex = argv.lastIndexOf("install");
  assert.ok(cmdIndex >= 0);
  argv[cmdIndex] = "update";
  const child = spawn(program, argv, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, output);
  return output;
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

    // A loopback 302 redirect to a tarball must be followed cleanly by the installer.
    const registry = await createRegistry();
    const redirector = createServer((req, res) => {
      if (req.url === "/disconnected.tgz") {
        req.socket.destroy();
        return;
      }
      if (req.url === "/start-disconnect.tgz") {
        res.writeHead(302, { location: "/disconnected.tgz" });
        res.end();
        return;
      }
      res.writeHead(302, { location: `${registry.base}${req.url ?? "/"}` });
      res.end();
    });
    try {
      await new Promise<void>(resolve => redirector.listen(0, "127.0.0.1", resolve));
      const redirectAddress = redirector.address();
      assert.ok(redirectAddress && typeof redirectAddress === "object");
      const redirectDir = join(directory, "loopback-redirect");
      mkdirSync(redirectDir, { recursive: true });
      writeFileSync(join(redirectDir, "package.json"), JSON.stringify({
        name: "redirect-root",
        dependencies: { "is-number": `http://127.0.0.1:${redirectAddress.port}/tarballs/is-number-7.0.0.tgz` },
      }));
      await install(target, redirectDir, registry.base);
      assert.equal(installedVersion(redirectDir, "is-number"), "7.0.0");

      // A failing redirect hop must report the destination URL that returned 404, not the initial URL.
      const missingRedirectDir = join(directory, "loopback-redirect-404");
      mkdirSync(missingRedirectDir, { recursive: true });
      const missingRedirectUrl = `http://127.0.0.1:${redirectAddress.port}/tarballs/missing.tgz`;
      writeFileSync(join(missingRedirectDir, "package.json"), JSON.stringify({
        name: "redirect-404-root",
        dependencies: { "missing-pkg": missingRedirectUrl },
      }));
      const redirect404Output = await install(target, missingRedirectDir, registry.base, [], 1);
      assert.ok(redirect404Output.includes(`${registry.base}/tarballs/missing.tgz`), `expected redirected failing URL in output:\n${redirect404Output}`);
      assert.ok(!redirect404Output.includes(`${missingRedirectUrl} - 404`), `expected failing hop URL instead of original URL:\n${redirect404Output}`);

      // A transport disconnect after a redirect must report the disconnected hop URL, not the initial URL.
      const disconnectDir = join(directory, "loopback-redirect-disconnect");
      mkdirSync(disconnectDir, { recursive: true });
      const startDisconnectUrl = `http://127.0.0.1:${redirectAddress.port}/start-disconnect.tgz`;
      const disconnectedUrl = `http://127.0.0.1:${redirectAddress.port}/disconnected.tgz`;
      writeFileSync(join(disconnectDir, "package.json"), JSON.stringify({
        name: "redirect-disconnect-root",
        dependencies: { "disconnect-pkg": startDisconnectUrl },
      }));
      const disconnectOutput = await install(target, disconnectDir, registry.base, [], 1);
      assert.ok(disconnectOutput.includes(disconnectedUrl), `expected disconnected hop URL in output:\n${disconnectOutput}`);
      assert.ok(!disconnectOutput.includes(`${startDisconnectUrl} -`), `expected failing hop URL instead of initial URL:\n${disconnectOutput}`);
    } finally {
      await new Promise<void>(resolve => redirector.close(() => resolve()));
      await registry.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function yamlCatalogPreservesNumericScalars(target: InstallFixtureTarget) {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-catalog-yaml-num-"));
  const registry = await createRegistry([packageFixture("versioned", "1.10.0")]);
  try {
    const cases: [string, string][] = [
      ["flow", "{packages: ['packages/*'], catalog: { versioned: 1.10 }}\n"],
      ["anchor", "packages:\n  - packages/*\ncatalog:\n  versioned: &pin 1.10\n  other: *pin\n"],
    ];
    for (const [name, yaml] of cases) {
      const root = join(directory, name);
      mkdirSync(join(root, "packages/app"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: `yaml-${name}` }));
      writeFileSync(join(root, "packages/app/package.json"), JSON.stringify({
        name: `@fixture/${name}`,
        version: "1.0.0",
        dependencies: { versioned: "catalog:" },
      }));
      writeFileSync(join(root, "pnpm-workspace.yaml"), yaml);

      await install(target, root, registry.base);
      assert.equal(installedVersion(root, "versioned"), "1.10.0");
      const lock = readFileSync(join(root, "bun.lock"), "utf8");
      assert.match(lock, /"versioned":\s*"1\.10"/);
    }

    // `bun update --latest` updates workspace catalog entries and installs the latest major version.
    const updateRoot = join(directory, "update-latest");
    mkdirSync(join(updateRoot, "packages/app"), { recursive: true });
    writeFileSync(join(updateRoot, "package.json"), JSON.stringify({
      name: "update-catalog-root",
      workspaces: {
        packages: ["packages/*"],
        catalog: { versioned: "^1.0.0" },
      },
    }, null, 2));
    writeFileSync(join(updateRoot, "packages/app/package.json"), JSON.stringify({
      name: "@fixture/update-app",
      version: "1.0.0",
      dependencies: { versioned: "catalog:" },
    }, null, 2));
    registry.latest.set("versioned", "2.0.0");
    await install(target, updateRoot, registry.base);
    assert.equal(installedVersion(updateRoot, "versioned"), "1.10.0");
    await runGuestUpdate(target, updateRoot, registry.base, ["--latest"]);
    assert.equal(installedVersion(updateRoot, "versioned"), "2.0.0");
    const updatedRootManifest = JSON.parse(readFileSync(join(updateRoot, "package.json"), "utf8")) as {
      workspaces: { catalog: { versioned: string } };
    };
    assert.equal(updatedRootManifest.workspaces.catalog.versioned, "^2.0.0");
    await install(target, updateRoot, registry.base, ["--frozen-lockfile"]);
  } finally {
    await registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const target of installFixtureTargets()) {
  test(`workspace catalogs and dist-tag lock replay work end-to-end (${target.engine})`, () => workspaceCatalogsRoundtrip(target), 120000);
  test(`missing catalog and failed tarball fetch report actionable diagnostics (${target.engine})`, () => missingCatalogAndFetchErrorContext(target), 120000);
  test(`YAML catalogs preserve numeric scalar precision end-to-end (${target.engine})`, () => yamlCatalogPreservesNumericScalars(target), 120000);
}
