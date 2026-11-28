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

async function runGuestUpdate(
  target: InstallFixtureTarget,
  directory: string,
  registry: string,
  args: string[],
  guestPwd = "/",
  expected = 0,
) {
  const [program, argv] = installFixtureCommand(directory, registry, args, true, [], target);
  const cmdIndex = argv.lastIndexOf("install");
  assert.ok(cmdIndex >= 0);
  argv[cmdIndex] = "update";
  if (guestPwd !== "/") {
    const pwdIndex = argv.indexOf("PWD=/");
    assert.ok(pwdIndex >= 0);
    argv[pwdIndex] = `PWD=${guestPwd}`;
  }
  const child = spawn(program, argv, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, expected, output);
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

    // `bun update --latest` updates workspace catalog entries even when root pins another version
    // via an npm alias, leaves unused catalogs untouched, and passes `--frozen-lockfile`.
    const updateRoot = join(directory, "update-latest");
    mkdirSync(join(updateRoot, "packages/app"), { recursive: true });
    writeFileSync(join(updateRoot, "package.json"), JSON.stringify({
      name: "update-catalog-root",
      dependencies: { versioned: "npm:versioned@1.0.0" },
      workspaces: {
        packages: ["packages/*"],
        catalog: { versioned: "^1.1.0" },
        catalogs: { unused: { versioned: "^1.1.0" } },
      },
    }, null, 2));
    writeFileSync(join(updateRoot, "packages/app/package.json"), JSON.stringify({
      name: "@fixture/update-app",
      version: "1.0.0",
      dependencies: { versioned: "catalog:" },
    }, null, 2));
    registry.latest.set("versioned", "2.0.0");
    await install(target, updateRoot, registry.base);
    assert.equal(installedVersion(updateRoot, "versioned"), "1.0.0");
    assert.equal(installedVersion(updateRoot, "@fixture/update-app/node_modules/versioned"), "1.10.0");
    await runGuestUpdate(target, updateRoot, registry.base, ["versioned", "--latest"]);
    assert.equal(installedVersion(updateRoot, "versioned"), "1.0.0");
    assert.equal(installedVersion(updateRoot, "@fixture/update-app/node_modules/versioned"), "2.0.0");
    const updatedRootManifest = JSON.parse(readFileSync(join(updateRoot, "package.json"), "utf8")) as {
      workspaces: { catalog: { versioned: string }; catalogs: { unused: { versioned: string } } };
    };
    assert.equal(updatedRootManifest.workspaces.catalog.versioned, "^2.0.0");
    assert.equal(updatedRootManifest.workspaces.catalogs.unused.versioned, "^1.1.0");
    await install(target, updateRoot, registry.base, ["--frozen-lockfile"]);

    // `bun update --latest` also updates catalog entries reached via `overrides` and keeps
    // root `catalog:` references attached on explicit `bun update pkg@ver`.
    const overrideUpdateRoot = join(directory, "update-override-catalog");
    mkdirSync(join(overrideUpdateRoot, "packages/app"), { recursive: true });
    writeFileSync(join(overrideUpdateRoot, "package.json"), JSON.stringify({
      name: "update-override-root",
      overrides: { versioned: "catalog:" },
      workspaces: {
        packages: ["packages/*"],
        catalog: { versioned: "^1.0.0" },
      },
    }, null, 2));
    writeFileSync(join(overrideUpdateRoot, "packages/app/package.json"), JSON.stringify({
      name: "@fixture/override-app",
      version: "1.0.0",
      dependencies: { versioned: "^1.0.0" },
    }, null, 2));
    await install(target, overrideUpdateRoot, registry.base);
    assert.equal(installedVersion(overrideUpdateRoot, "versioned"), "1.10.0");
    await runGuestUpdate(target, overrideUpdateRoot, registry.base, ["versioned", "--latest"]);
    assert.equal(installedVersion(overrideUpdateRoot, "versioned"), "2.0.0");
    const overrideManifest = JSON.parse(readFileSync(join(overrideUpdateRoot, "package.json"), "utf8")) as {
      workspaces: { catalog: { versioned: string } };
    };
    assert.equal(overrideManifest.workspaces.catalog.versioned, "^2.0.0");
    await install(target, overrideUpdateRoot, registry.base, ["--frozen-lockfile"]);

    // `bun update --latest` with a catalog peer `^2.0.0` and a sibling pinned to `1.0.0` must
    // keep the catalog at `^2.0.0` instead of downgrading it to the sibling's `1.0.0`.
    const peerUpdateRoot = join(directory, "update-peer-catalog");
    mkdirSync(join(peerUpdateRoot, "packages/a"), { recursive: true });
    mkdirSync(join(peerUpdateRoot, "packages/b"), { recursive: true });
    writeFileSync(join(peerUpdateRoot, "package.json"), JSON.stringify({
      name: "update-peer-root",
      workspaces: {
        packages: ["packages/*"],
        catalog: { versioned: "^2.0.0" },
      },
    }, null, 2));
    writeFileSync(join(peerUpdateRoot, "packages/a/package.json"), JSON.stringify({
      name: "@fixture/peer-a",
      version: "1.0.0",
      dependencies: { versioned: "1.0.0" },
    }, null, 2));
    writeFileSync(join(peerUpdateRoot, "packages/b/package.json"), JSON.stringify({
      name: "@fixture/peer-b",
      version: "1.0.0",
      peerDependencies: { versioned: "catalog:" },
    }, null, 2));
    await install(target, peerUpdateRoot, registry.base);
    await runGuestUpdate(target, peerUpdateRoot, registry.base, ["--latest"]);
    const peerManifest = JSON.parse(readFileSync(join(peerUpdateRoot, "package.json"), "utf8")) as {
      workspaces: { catalog: { versioned: string } };
    };
    assert.equal(peerManifest.workspaces.catalog.versioned, "^2.0.0");
    assert.equal(installedVersion(peerUpdateRoot, "versioned"), "1.0.0");
    assert.equal(installedVersion(peerUpdateRoot, "@fixture/peer-b/node_modules/versioned"), "2.0.0");
    await install(target, peerUpdateRoot, registry.base, ["--frozen-lockfile"]);

    // `bun update --latest` with a root npm alias providing a catalog peer must neither 404 on the
    // alias name (from root or workspace member) nor downgrade a `^2.0.0` catalog entry to `^1.0.0`.
    for (const [label, catalogSpec] of [["tag", "latest"], ["range", "^2.0.0"]] as const) {
      const aliasPeerRoot = join(directory, `update-alias-peer-${label}`);
      mkdirSync(join(aliasPeerRoot, "packages/a"), { recursive: true });
      writeFileSync(join(aliasPeerRoot, "package.json"), JSON.stringify({
        name: `update-alias-peer-${label}-root`,
        dependencies: { "logical-alias": "npm:versioned@1.0.0" },
        workspaces: {
          packages: ["packages/*"],
          catalog: { "logical-alias": catalogSpec },
        },
      }, null, 2));
      writeFileSync(join(aliasPeerRoot, "packages/a/package.json"), JSON.stringify({
        name: "@fixture/alias-peer-a",
        version: "1.0.0",
        peerDependencies: { "logical-alias": "catalog:" },
      }, null, 2));
      await install(target, aliasPeerRoot, registry.base);
      await runGuestUpdate(target, aliasPeerRoot, registry.base, ["--latest"]);
      await runGuestUpdate(target, aliasPeerRoot, registry.base, ["--latest"], "/packages/a");
      const aliasManifest = JSON.parse(readFileSync(join(aliasPeerRoot, "package.json"), "utf8")) as {
        workspaces: { catalog: { "logical-alias": string } };
      };
      assert.equal(aliasManifest.workspaces.catalog["logical-alias"], catalogSpec);
      assert.equal(installedVersion(aliasPeerRoot, "logical-alias"), "1.0.0");
      await install(target, aliasPeerRoot, registry.base, ["--frozen-lockfile"]);
    }

    // `bun update --latest` from a member, `bun update --latest` with `pnpm-workspace.yaml`,
    // and plain `bun update` preserving catalog dist-tags must all match native Bun.
    const memberUpdateRoot = join(directory, "update-member-catalog");
    mkdirSync(join(memberUpdateRoot, "packages/a"), { recursive: true });
    mkdirSync(join(memberUpdateRoot, "packages/b"), { recursive: true });
    writeFileSync(join(memberUpdateRoot, "package.json"), JSON.stringify({
      name: "update-member-root",
      workspaces: { packages: ["packages/*"], catalog: { versioned: "^1.0.0", "is-number": "^7.0.0" } },
    }, null, 2));
    writeFileSync(join(memberUpdateRoot, "packages/a/package.json"), JSON.stringify({
      name: "@fixture/member-cat-a",
      version: "1.0.0",
      dependencies: { versioned: "catalog:" },
    }, null, 2));
    writeFileSync(join(memberUpdateRoot, "packages/b/package.json"), JSON.stringify({
      name: "@fixture/member-cat-b",
      version: "1.0.0",
      dependencies: { "is-number": "catalog:" },
    }, null, 2));
    await install(target, memberUpdateRoot, registry.base);
    const outOfScopeOutput = await runGuestUpdate(target, memberUpdateRoot, registry.base, ["is-number", "--latest"], "/packages/a", 1);
    assert.match(outOfScopeOutput, /is not a dependency of this workspace/);
    await runGuestUpdate(target, memberUpdateRoot, registry.base, ["--latest"], "/packages/a");
    assert.equal(
      (JSON.parse(readFileSync(join(memberUpdateRoot, "package.json"), "utf8")) as {
        workspaces: { catalog: { versioned: string } };
      }).workspaces.catalog.versioned,
      "^2.0.0",
    );
    assert.equal(installedVersion(memberUpdateRoot, "versioned"), "2.0.0");
    await install(target, memberUpdateRoot, registry.base, ["--frozen-lockfile"]);

    for (const [label, hasPackages] of [["with-packages", true], ["root-only", false]] as const) {
      const pnpmUpdateRoot = join(directory, `update-pnpm-catalog-${label}`);
      mkdirSync(join(pnpmUpdateRoot, "packages/a"), { recursive: true });
      writeFileSync(
        join(pnpmUpdateRoot, "package.json"),
        JSON.stringify(hasPackages ? { name: `update-pnpm-${label}` } : { name: `update-pnpm-${label}`, dependencies: { versioned: "catalog:" } }, null, 2),
      );
      writeFileSync(
        join(pnpmUpdateRoot, "pnpm-workspace.yaml"),
        `${hasPackages ? "packages:\n  - packages/*\n" : ""}catalog:\n  versioned: ^1.0.0\n`,
      );
      if (hasPackages) {
        writeFileSync(join(pnpmUpdateRoot, "packages/a/package.json"), JSON.stringify({
          name: "@fixture/pnpm-cat-a",
          version: "1.0.0",
          dependencies: { versioned: "catalog:" },
        }, null, 2));
      }
      await install(target, pnpmUpdateRoot, registry.base);
      await runGuestUpdate(target, pnpmUpdateRoot, registry.base, ["--latest"]);
      assert.equal(
        (JSON.parse(readFileSync(join(pnpmUpdateRoot, "package.json"), "utf8")) as {
          workspaces: { catalog: { versioned: string } };
        }).workspaces.catalog.versioned,
        "^2.0.0",
      );
      assert.equal(installedVersion(pnpmUpdateRoot, "versioned"), "2.0.0");
      await install(target, pnpmUpdateRoot, registry.base, ["--frozen-lockfile"]);
    }

    const tagUpdateRoot = join(directory, "update-tag-catalog");
    mkdirSync(join(tagUpdateRoot, "packages/a"), { recursive: true });
    writeFileSync(join(tagUpdateRoot, "package.json"), JSON.stringify({
      name: "update-tag-root",
      workspaces: { packages: ["packages/*"], catalog: { versioned: "latest" } },
    }, null, 2));
    writeFileSync(join(tagUpdateRoot, "packages/a/package.json"), JSON.stringify({
      name: "@fixture/tag-cat-a",
      version: "1.0.0",
      dependencies: { versioned: "catalog:" },
    }, null, 2));
    registry.latest.set("versioned", "1.0.0");
    await install(target, tagUpdateRoot, registry.base);
    assert.equal(installedVersion(tagUpdateRoot, "versioned"), "1.0.0");
    registry.latest.set("versioned", "2.0.0");
    await runGuestUpdate(target, tagUpdateRoot, registry.base, []);
    assert.equal(
      (JSON.parse(readFileSync(join(tagUpdateRoot, "package.json"), "utf8")) as {
        workspaces: { catalog: { versioned: string } };
      }).workspaces.catalog.versioned,
      "latest",
    );
    assert.equal(installedVersion(tagUpdateRoot, "versioned"), "2.0.0");
    await install(target, tagUpdateRoot, registry.base, ["--frozen-lockfile"]);

    // Sibling peer reusing root-pinned 1.0.0 must not overwrite member A's 1.10.0 during `--exact`.
    const exactPeerRoot = join(directory, "update-exact-peer");
    mkdirSync(join(exactPeerRoot, "packages/a"), { recursive: true });
    mkdirSync(join(exactPeerRoot, "packages/b"), { recursive: true });
    writeFileSync(join(exactPeerRoot, "package.json"), JSON.stringify({
      name: "update-exact-peer-root",
      dependencies: { versioned: "1.0.0" },
      workspaces: { packages: ["packages/*"], catalog: { versioned: "^1.0.0" } },
    }, null, 2));
    writeFileSync(join(exactPeerRoot, "packages/a/package.json"), JSON.stringify({
      name: "@fixture/exact-a",
      version: "1.0.0",
      dependencies: { versioned: "catalog:" },
    }, null, 2));
    writeFileSync(join(exactPeerRoot, "packages/b/package.json"), JSON.stringify({
      name: "@fixture/exact-b",
      version: "1.0.0",
      peerDependencies: { versioned: "catalog:" },
    }, null, 2));
    await install(target, exactPeerRoot, registry.base);
    await runGuestUpdate(target, exactPeerRoot, registry.base, ["--exact"], "/packages/a");
    assert.equal(
      (JSON.parse(readFileSync(join(exactPeerRoot, "package.json"), "utf8")) as {
        workspaces: { catalog: { versioned: string } };
      }).workspaces.catalog.versioned,
      "^1.10.0",
    );
    assert.equal(installedVersion(exactPeerRoot, "@fixture/exact-a/node_modules/versioned"), "1.10.0");
    await install(target, exactPeerRoot, registry.base, ["--frozen-lockfile"]);
    await runGuestUpdate(target, exactPeerRoot, registry.base, ["--latest", "--exact"], "/packages/a");
    assert.equal(
      (JSON.parse(readFileSync(join(exactPeerRoot, "package.json"), "utf8")) as {
        workspaces: { catalog: { versioned: string } };
      }).workspaces.catalog.versioned,
      "^2.0.0",
    );
    await install(target, exactPeerRoot, registry.base, ["--frozen-lockfile"]);

    // Explicit `bun update pkg@ver` leaves unused alias catalogs intact, and plain `bun update`
    // preserves comparator catalog ranges (`>=1.0.0 <2.0.0`) instead of narrowing them.
    const rangeAndUnusedRoot = join(directory, "update-range-and-unused");
    mkdirSync(join(rangeAndUnusedRoot, "packages/a"), { recursive: true });
    writeFileSync(join(rangeAndUnusedRoot, "package.json"), JSON.stringify({
      name: "update-range-unused-root",
      dependencies: { versioned: "^1.0.0" },
      workspaces: {
        packages: ["packages/*"],
        catalog: { versioned: ">=1.0.0 <2.0.0" },
        catalogs: { tools: { versioned: "npm:is-number@^7.0.0" } },
      },
    }, null, 2));
    writeFileSync(join(rangeAndUnusedRoot, "packages/a/package.json"), JSON.stringify({
      name: "@fixture/range-a",
      version: "1.0.0",
      dependencies: { versioned: "catalog:" },
    }, null, 2));
    await install(target, rangeAndUnusedRoot, registry.base);
    await runGuestUpdate(target, rangeAndUnusedRoot, registry.base, []);
    let rangeManifest = JSON.parse(readFileSync(join(rangeAndUnusedRoot, "package.json"), "utf8")) as {
      dependencies: { versioned: string };
      workspaces: { catalog: { versioned: string }; catalogs: { tools: { versioned: string } } };
    };
    assert.equal(rangeManifest.workspaces.catalog.versioned, ">=1.0.0 <2.0.0");
    await runGuestUpdate(target, rangeAndUnusedRoot, registry.base, ["versioned@1.10.0"]);
    rangeManifest = JSON.parse(readFileSync(join(rangeAndUnusedRoot, "package.json"), "utf8")) as typeof rangeManifest;
    assert.equal(rangeManifest.workspaces.catalogs.tools.versioned, "npm:is-number@^7.0.0");
    await install(target, rangeAndUnusedRoot, registry.base, ["--frozen-lockfile"]);

    // Member's first `bun update --latest` with a `yarn.lock` migrates against the original catalog.
    const yarnMemberUpdateRoot = join(directory, "update-yarn-member");
    mkdirSync(join(yarnMemberUpdateRoot, "packages/a"), { recursive: true });
    writeFileSync(join(yarnMemberUpdateRoot, "package.json"), JSON.stringify({
      name: "update-yarn-member-root",
      workspaces: { packages: ["packages/*"], catalog: { versioned: "^1.0.0" } },
    }, null, 2));
    writeFileSync(join(yarnMemberUpdateRoot, "packages/a/package.json"), JSON.stringify({
      name: "@fixture/yarn-upd-a",
      version: "1.0.0",
      dependencies: { versioned: "catalog:" },
    }, null, 2));
    writeFileSync(join(yarnMemberUpdateRoot, "yarn.lock"), [
      "# yarn lockfile v1",
      "",
      "versioned@^1.0.0:",
      "  version \"1.10.0\"",
      `  resolved "${registry.base}/versioned/-/versioned-1.10.0.tgz"`,
      "",
    ].join("\n"));
    await runGuestUpdate(target, yarnMemberUpdateRoot, registry.base, ["--latest"], "/packages/a");
    assert.equal(
      (JSON.parse(readFileSync(join(yarnMemberUpdateRoot, "package.json"), "utf8")) as {
        workspaces: { catalog: { versioned: string } };
      }).workspaces.catalog.versioned,
      "^2.0.0",
    );
    assert.equal(installedVersion(yarnMemberUpdateRoot, "versioned"), "2.0.0");
    await install(target, yarnMemberUpdateRoot, registry.base, ["--frozen-lockfile"]);

    // Auto-installed pnpm workspace peer links normalize into workspace peer requirements.
    const pnpmPeerLinkRoot = join(directory, "pnpm-peer-workspace-link");
    mkdirSync(join(pnpmPeerLinkRoot, "packages/app"), { recursive: true });
    mkdirSync(join(pnpmPeerLinkRoot, "packages/lib"), { recursive: true });
    writeFileSync(join(pnpmPeerLinkRoot, "package.json"), JSON.stringify({
      name: "fixture-root",
      workspaces: ["packages/*"],
    }, null, 2));
    writeFileSync(join(pnpmPeerLinkRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(join(pnpmPeerLinkRoot, "packages/app/package.json"), JSON.stringify({
      name: "fixture-app",
      version: "1.0.0",
      peerDependencies: { "fixture-lib": "workspace:*" },
    }, null, 2));
    writeFileSync(join(pnpmPeerLinkRoot, "packages/lib/package.json"), JSON.stringify({
      name: "fixture-lib",
      version: "1.0.0",
    }, null, 2));
    writeFileSync(join(pnpmPeerLinkRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "  packages/app:",
      "    dependencies:",
      "      fixture-lib:",
      "        specifier: workspace:*",
      "        version: link:../lib",
      "  packages/lib: {}",
      "",
    ].join("\n"));
    await install(target, pnpmPeerLinkRoot, registry.base, ["--lockfile-only"]);
    await install(target, pnpmPeerLinkRoot, registry.base, ["--frozen-lockfile", "--lockfile-only"]);

    // `bun update --latest --lockfile-only` updates npm-prefixed catalog ranges and aliases.
    for (const [label, initialSpec, expectedSpec] of [
      ["npm-range", "npm:^1.0.0", "^2.0.0"],
      ["npm-alias", "npm:versioned@^1.0.0", "npm:versioned@^2.0.0"],
    ] as const) {
      const npmCatRoot = join(directory, `update-${label}`);
      mkdirSync(join(npmCatRoot, "packages/a"), { recursive: true });
      writeFileSync(join(npmCatRoot, "package.json"), JSON.stringify({
        name: "root",
        workspaces: {
          packages: ["packages/*"],
          catalog: { versioned: initialSpec },
        },
      }, null, 2));
      writeFileSync(join(npmCatRoot, "packages/a/package.json"), JSON.stringify({
        name: "@fixture/npm-cat-a",
        version: "1.0.0",
        dependencies: { versioned: "catalog:" },
      }, null, 2));
      await install(target, npmCatRoot, registry.base, ["--lockfile-only"]);
      assert.match(readFileSync(join(npmCatRoot, "bun.lock"), "utf8"), /"versioned@1\.10\.0"/);
      await runGuestUpdate(target, npmCatRoot, registry.base, ["--latest", "--lockfile-only"]);
      const updatedManifest = JSON.parse(readFileSync(join(npmCatRoot, "package.json"), "utf8")) as {
        workspaces: { catalog: { versioned: string } };
      };
      assert.equal(updatedManifest.workspaces.catalog.versioned, expectedSpec);
      assert.match(readFileSync(join(npmCatRoot, "bun.lock"), "utf8"), /"versioned@2\.0\.0"/);
      await install(target, npmCatRoot, registry.base, ["--frozen-lockfile", "--lockfile-only"]);
    }
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
