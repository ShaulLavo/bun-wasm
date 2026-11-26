import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateReleaseLock, verifyUnrelatedPackages } from "./ci-update-lock";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const repoRoot = join(import.meta.dir, "..");
const updater = join(repoRoot, ".github/scripts/update-owned-dependencies.sh");
const checkManifests = join(repoRoot, ".github/scripts/check-manifests.sh");
const checkUpdatePaths = join(repoRoot, ".github/scripts/check-update-paths.sh");
const waffleDownload = "https://github.com/ShaulLavo/waffle/releases/download";
const npmRegistry = "https://registry.npmjs.org";

function makeTgz(files: Record<string, string>): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "bun-wasm-tgz-"));
  try {
    const pkgDir = join(dir, "package");
    mkdirSync(pkgDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(pkgDir, name, ".."), { recursive: true });
      writeFileSync(join(pkgDir, name), content);
    }
    const out = join(dir, "archive.tgz");
    execFileSync("tar", ["-czf", out, "-C", dir, "package"]);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha512Sri(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifests(runtime: string, relay: string, programs: string, bashUrl: string) {
  const waffle = `npm:@waffle-os/runtime@${runtime}`;
  const base = `${waffleDownload}/programs-v${programs}/waffle-base-${programs}.tgz`;
  return {
    "package.json": {
      devDependencies: { "@waffle-os/runtime": runtime, waffle, "@waffle-os/relay": relay },
      peerDependencies: { "waffle-base": base, "@waffle-os/relay": relay },
    },
    "web/package.json": {
      dependencies: { "@waffle-os/runtime": runtime, waffle, "waffle-base": base, "@waffle-os/relay": relay, "bash-web": bashUrl },
    },
    "sandbox/package.json": {
      dependencies: { waffle, "waffle-base": base, "bash-web": bashUrl },
    },
  };
}

async function writeTree(root: string, files: Readonly<Record<string, string>>) {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  }
}

const jsonFiles = (files: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(files).map(([file, value]) => [file, `${JSON.stringify(value, null, 2)}\n`]));

test("npm-to-npm bash-web upgrade verifies canonical tag + gitHead + SHA-512 and passes manifest/path checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-owned-update-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const oldCommit = "1".repeat(40);
    const newTarball = makeTgz({ "package.json": JSON.stringify({ name: "bash-web", version: "0.0.115" }) });
    const newIntegrity = sha512Sri(newTarball);
    const newSha256 = sha256Hex(newTarball);

    // Create a local bare git repo with canonical tag refs/tags/bash-web@0.0.115 pointing to a real commit.
    const bareGit = join(root, "bash-web.git");
    const workGit = join(root, "bash-web-work");
    execFileSync("git", ["init", "--bare", bareGit]);
    execFileSync("git", ["init", "-b", "main", workGit]);
    execFileSync("git", ["-C", workGit, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", workGit, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(workGit, "README.md"), "bash-web 0.0.115\n");
    execFileSync("git", ["-C", workGit, "add", "."]);
    execFileSync("git", ["-C", workGit, "commit", "-m", "release 0.0.115"]);
    const newCommit = execFileSync("git", ["-C", workGit, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", workGit, "tag", "-a", "bash-web@0.0.115", "-m", "bash-web@0.0.115", newCommit]);
    execFileSync("git", ["-C", workGit, "remote", "add", "origin", bareGit]);
    execFileSync("git", ["-C", workGit, "push", "origin", "main", "--tags"]);

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/bash-web/0.0.115") {
          return Response.json({
            name: "bash-web",
            version: "0.0.115",
            gitHead: newCommit,
            dist: {
              tarball: `${npmRegistry}/bash-web/-/bash-web-0.0.115.tgz`,
              integrity: newIntegrity,
            },
          });
        }
        if (pathname === "/bash-web/-/bash-web-0.0.115.tgz") {
          return new Response(Buffer.from(newTarball), { headers: { "content-type": "application/gzip" } });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]] || exit 2
path=$2; filter=.; shift 2
while [[ $# -gt 0 ]]; do case "$1" in --jq) filter=$2; shift 2 ;; *) shift ;; esac; done
case "$path" in
  repos/ShaulLavo/waffle/releases*) jq -r "$filter" "$FIXTURE_ROOT/waffle.json" ;;
  *) echo "unexpected gh path $path" >&2; exit 2 ;;
esac
`;
    const fakeNpm = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $4" == "view --registry=https://registry.npmjs.org/ dist-tags.latest" ]]
case "$3" in
  @waffle-os/runtime) echo 0.0.148 ;;
  @waffle-os/relay) echo 0.0.148 ;;
  bash-web) echo 0.0.115 ;;
  *) exit 2 ;;
esac
`;

    const repository = join(root, "repository");
    const oldUrl = `${npmRegistry}/bash-web/-/bash-web-0.0.114.tgz`;
    const newUrl = `${npmRegistry}/bash-web/-/bash-web-0.0.115.tgz`;
    await writeTree(repository, {
      ...jsonFiles(manifests("0.0.147", "0.0.147", "0.0.22", oldUrl)),
      "scripts/bash-web-release-inputs.json": `${JSON.stringify({
        url: oldUrl,
        sha256: "a".repeat(64),
        bytes: 123,
        version: "0.0.114",
        sourceCommit: oldCommit,
      }, null, 2)}\n`,
      "scripts/build-bash-web-shell.sh": `commit=${oldCommit}\n`,
      ".github/scripts/update-waffle-records.sh": "exit 0\n",
      "scripts/ci-update-lock.ts": "export {};\n",
    });

    // Initialize git so check-manifests.sh & check-update-paths.sh can diff real changes.
    execFileSync("git", ["init", "-b", "main", repository]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "base"]);

    await writeTree(root, {
      "bin/gh": fakeGh,
      "bin/npm": fakeNpm,
      "waffle.json": JSON.stringify([
        { tag_name: "programs-v0.0.23", draft: false, prerelease: false },
        { tag_name: "programs-v0.0.22", draft: false, prerelease: false },
      ]),
    });
    await chmod(join(root, "bin/gh"), 0o755);
    await chmod(join(root, "bin/npm"), 0o755);

    const proc = Bun.spawn(["bash", updater], {
      cwd: repository,
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        FIXTURE_ROOT: root,
        NPM_REGISTRY: server.url.origin,
        BASH_WEB_GIT_URL: bareGit,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);

    for (const [file, text] of Object.entries(jsonFiles(manifests("0.0.148", "0.0.148", "0.0.23", newUrl)))) {
      expect(await readFile(join(repository, file), "utf8")).toBe(text);
    }
    const updatedRecord = JSON.parse(await readFile(join(repository, "scripts/bash-web-release-inputs.json"), "utf8"));
    expect(updatedRecord).toEqual({
      url: newUrl,
      sha256: newSha256,
      bytes: newTarball.byteLength,
      version: "0.0.115",
      sourceCommit: newCommit,
    });
    expect(await readFile(join(repository, "scripts/build-bash-web-shell.sh"), "utf8")).toBe(`commit=${newCommit}\n`);

    const manifestCheck = Bun.spawnSync(["bash", checkManifests], { cwd: repository, stdout: "pipe", stderr: "pipe" });
    expect(manifestCheck.stderr.toString()).toBe("");
    expect(manifestCheck.exitCode).toBe(0);

    const pathCheck = Bun.spawnSync(["bash", checkUpdatePaths], { cwd: repository, stdout: "pipe", stderr: "pipe" });
    expect(pathCheck.stderr.toString()).toBe("");
    expect(pathCheck.exitCode).toBe(0);
  } finally {
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("verifyUnrelatedPackages authorizes hoisted-to-nested split + root-slot peer rebinding and rejects nested peer spoofing", () => {
  const bashUrl = `${npmRegistry}/bash-web/-/bash-web-0.0.114.tgz`;
  const base23Url = `${waffleDownload}/programs-v0.0.23/waffle-base-0.0.23.tgz`;
  const base24Url = `${waffleDownload}/programs-v0.0.24/waffle-base-0.0.24.tgz`;
  const core23Url = `${waffleDownload}/programs-v0.0.23/waffle-coreutils-0.0.23.tgz`;
  const core24Url = `${waffleDownload}/programs-v0.0.24/waffle-coreutils-0.0.24.tgz`;

  const oldManifest = {
    dependencies: {
      "bash-web": bashUrl,
      "waffle-base": base23Url,
      waffle: "npm:@waffle-os/runtime@0.0.147",
    },
  };
  const newManifest = {
    dependencies: {
      "bash-web": bashUrl,
      "waffle-base": base24Url,
      waffle: "npm:@waffle-os/runtime@0.0.148",
    },
  };

  const beforeLock = {
    workspaces: {
      "": {
        dependencies: oldManifest.dependencies,
      },
    },
    packages: {
      "bash-web": [`bash-web@${bashUrl}`, { dependencies: { "waffle-base": base23Url } }, "sha512-bash114"],
      "waffle-base": [
        `waffle-base@${base23Url}`,
        { dependencies: { "waffle-coreutils": core23Url }, peerDependencies: { waffle: "*" } },
        "sha512-base23",
      ],
      "waffle-coreutils": [`waffle-coreutils@${core23Url}`, {}, "sha512-core23"],
      waffle: ["@waffle-os/runtime@0.0.147", "", {}, "sha512-waffle147"],
    },
  };

  // Valid split: direct waffle-base advances to 0.0.24, root waffle advances to 0.0.148,
  // bash-web retains 0.0.23 via verbatim relocated nested slots, and peer waffle rebinds to root slot.
  const validAfterLock = {
    workspaces: {
      "": {
        dependencies: newManifest.dependencies,
      },
    },
    packages: {
      "bash-web": [`bash-web@${bashUrl}`, { dependencies: { "waffle-base": base23Url } }, "sha512-bash114"],
      "bash-web/waffle-base": [
        `waffle-base@${base23Url}`,
        { dependencies: { "waffle-coreutils": core23Url }, peerDependencies: { waffle: "*" } },
        "sha512-base23",
      ],
      "bash-web/waffle-coreutils": [`waffle-coreutils@${core23Url}`, {}, "sha512-core23"],
      "waffle-base": [
        `waffle-base@${base24Url}`,
        { dependencies: { "waffle-coreutils": core24Url }, peerDependencies: { waffle: "*" } },
        "sha512-base24",
      ],
      "waffle-coreutils": [`waffle-coreutils@${core24Url}`, {}, "sha512-core24"],
      waffle: ["@waffle-os/runtime@0.0.148", "", {}, "sha512-waffle148"],
    },
  };

  const staged = new Map([
    [base24Url, { kind: "release" as const, manifest: {}, integrity: "sha512-base24", archive: "" }],
    [core24Url, { kind: "release" as const, manifest: {}, integrity: "sha512-core24", archive: "" }],
  ]);

  const locations = new Map([
    [base24Url, "file:/staged/base24.tgz"],
    [core24Url, "file:/staged/core24.tgz"],
  ]);

  expect(() =>
    verifyUnrelatedPackages(
      JSON.stringify(beforeLock),
      JSON.stringify(validAfterLock),
      locations,
      staged,
      newManifest,
    ),
  ).not.toThrow();

  // Negative nested-peer fixture: inject a same-version nested slot `bash-web/waffle-base/waffle`
  // with altered integrity/metadata so the unchanged peer edge resolves to a nested slot instead of root `waffle`.
  const spoofedPeerLock = {
    ...validAfterLock,
    packages: {
      ...validAfterLock.packages,
      "bash-web/waffle-base/waffle": ["@waffle-os/runtime@0.0.148", "", {}, "sha512-SPOOFED"],
    },
  };

  expect(() =>
    verifyUnrelatedPackages(
      JSON.stringify(beforeLock),
      JSON.stringify(spoofedPeerLock),
      locations,
      staged,
      newManifest,
    ),
  ).toThrow(/unrelated peer provider/i);
});

test("verifyUnrelatedPackages sees devDependencies pin updates even when peerDependencies keeps a wildcard", () => {
  const beforeLock = {
    workspaces: {
      "": {
        devDependencies: { waffle: "npm:@waffle-os/runtime@0.0.150" },
        peerDependencies: { waffle: "*" },
      },
    },
    packages: {
      waffle: ["@waffle-os/runtime@0.0.150", "", {}, "sha512-waffle150"],
    },
  };
  const newManifest = {
    devDependencies: { waffle: "npm:@waffle-os/runtime@0.0.152" },
    peerDependencies: { waffle: "*" },
  };
  const afterLock = {
    workspaces: {
      "": newManifest,
    },
    packages: {
      waffle: ["@waffle-os/runtime@0.0.152", "", {}, "sha512-waffle152"],
    },
  };

  expect(() =>
    verifyUnrelatedPackages(
      JSON.stringify(beforeLock),
      JSON.stringify(afterLock),
      new Map(),
      new Map(),
      newManifest,
    ),
  ).not.toThrow();
});

test("updateReleaseLock fails with Locked release integrity mismatch on tampered unchanged npm bash-web archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-lock-tamper-"));
  try {
    const bashUrl = `${npmRegistry}/bash-web/-/bash-web-0.0.114.tgz`;
    const originalArchive = makeTgz({ "package.json": JSON.stringify({ name: "bash-web", version: "0.0.114" }) });
    const tamperedArchive = makeTgz({
      "package.json": JSON.stringify({ name: "bash-web", version: "0.0.114", description: "tampered" }),
    });
    const originalLock = `${JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { dependencies: { "bash-web": bashUrl } } },
      packages: { "bash-web": [`bash-web@${bashUrl}`, {}, sha512Sri(originalArchive)] },
    }, null, 2)}\n`;

    await writeTree(root, {
      "package.json": `${JSON.stringify({ name: "fixture", dependencies: { "bash-web": bashUrl } }, null, 2)}\n`,
      "bun.lock": originalLock,
      "scripts/bash-web-release-inputs.json": `${JSON.stringify({
        url: bashUrl,
        sha256: sha256Hex(originalArchive),
        bytes: originalArchive.byteLength,
        version: "0.0.114",
        sourceCommit: "a".repeat(40),
      }, null, 2)}\n`,
    });

    await expect(
      updateReleaseLock(root, async (url) => {
        if (url === bashUrl) return new Response(Buffer.from(tamperedArchive), { status: 200 });
        return new Response("Not found", { status: 404 });
      }),
    ).rejects.toThrow("Locked release integrity mismatch");

    expect(await readFile(join(root, "bun.lock"), "utf8")).toBe(originalLock);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
