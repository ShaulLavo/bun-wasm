import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudConfig, guestCommand } from "./guest.ts";
import { baseImage, browserPreparation, imageIdentityPath, imageVersion, playwrightIntegrity, playwrightVersion, publishPreparedImage, validatePreparationIdle, validatePreparationTarget } from "./image.ts";
import { runnerEnvironment } from "./runner-guest.ts";
import { qemuArgs } from "./vm.ts";

test("browser base pin matches both frozen package sources", async () => {
  for (const lock of ["../../bun.lock", "../../web/bun.lock"]) {
    const text = await readFile(new URL(lock, import.meta.url), "utf8");
    expect(text).toContain(`"playwright-core@${playwrightVersion}"`);
    expect(text).toContain(playwrightIntegrity);
  }
});

test("maintenance rejects a live, starting or stopping production lifecycle and retained jobs", () => {
  for (const state of ["active", "activating", "deactivating", "reloading", "unknown"]) {
    expect(() => validatePreparationIdle(state, "inactive", 0)).toThrow();
    expect(() => validatePreparationIdle("inactive", state, 0)).toThrow();
  }
  expect(() => validatePreparationIdle("inactive", "inactive", 1)).toThrow();
  expect(() => validatePreparationIdle("inactive", "inactive", 0)).not.toThrow();
});

test("preparation accepts only the explicit new versioned target", () => {
  expect(() => validatePreparationTarget(baseImage)).not.toThrow();
  for (const target of [undefined, "ci-base-v1.qcow2", `/work/ci-runner/bun-wasm/images/${baseImage}`, `../${baseImage}`, "other.qcow2"]) {
    expect(() => validatePreparationTarget(target)).toThrow("explicit target");
  }
});

test("base recipe installs verified pinned CLI system dependencies and then checks the complete closure", () => {
  const [shell, mode, script = ""] = browserPreparation();
  expect([shell, mode]).toEqual(["bash", "-euc"]);
  expect(spawnSync("bash", ["-n", "-c", script]).status).toBe(0);
  expect(script).toContain(`https://registry.npmjs.org/playwright-core/-/playwright-core-${playwrightVersion}.tgz`);
  expect(script).toContain("sha512sum --check --status");
  expect(script).toContain("trap 'rm -rf -- /work/provision/browser-deps' EXIT");
  expect(script).toContain("--max-time 180 --retry 2 --retry-max-time 400 --max-filesize 16777216");
  const install = script.indexOf("cli.js install-deps chromium firefox webkit");
  const verify = script.indexOf("cli.js install-deps --dry-run chromium firefox webkit");
  expect(install).toBeGreaterThan(script.indexOf("sha512sum --check"));
  expect(verify).toBeGreaterThan(install);
  expect(script.indexOf(`> ${imageIdentityPath}`)).toBeGreaterThan(verify);
  expect(script).not.toMatch(/--with-deps|cli.js install |allow-unauthenticated|trusted=yes|apt-get (?:remove|purge)|Listener (?:run|configure)/);
});

test("all guest entry points bind the new image identity without relabeling old installed bytes", () => {
  expect(runnerEnvironment().ImageVersion).toBe(imageVersion);
  const command = guestCommand(["node", "probe.ts"]);
  expect(command).toStartWith(`test "$(cat ${imageIdentityPath})" = '${imageVersion}' &&`);
  expect(command).toContain("RUNNER_TEMP=/work/t TMPDIR=/work/t");
  expect(command).toContain("cd /work/w/bun-wasm/bun-wasm");
  const preparing = cloudConfig("ssh-ed25519 fixture", true, false);
  const job = cloudConfig("ssh-ed25519 fixture", false, false);
  const startup = (source: string) => {
    const config: unknown = JSON.parse(source.slice(source.indexOf("\n") + 1));
    if (!config || typeof config !== "object" || !("runcmd" in config)) throw new Error("Missing guest startup commands");
    return JSON.stringify(config.runcmd);
  };
  expect(startup(preparing)).toContain("cli.js install-deps --dry-run chromium firefox webkit");
  expect(startup(job)).not.toContain("cli.js install-deps --dry-run chromium firefox webkit");
  expect(startup(preparing)).not.toContain("virtio-bunwasmcache");
  expect(job).toContain("/opt/bun-wasm-ci/image.ts");
  expect(job).not.toContain("mount /dev/disk/by-id/virtio-bunwasmcache");
  expect(job).not.toContain("/home/shaul");
  expect(preparing).toContain("build-essential");
  expect(preparing).toContain("libclang-dev");
  expect(preparing).toContain("v26.13.1");
  expect(preparing).toContain("v2.338.2");
});

test("preparation has no persistent cache device and retains the existing native VM budget", () => {
  const job = { id: "a".repeat(36), profile: "native", prepare: true } satisfies Parameters<typeof qemuArgs>[0];
  const args = qemuArgs(job, 12345);
  expect(args).not.toContain("virtio-blk-pci,drive=cache,serial=bunwasmcache");
  expect(args.join(" ")).not.toContain("/cache/cache.raw");
  expect(args).toContain("6144");
  expect(args).toContain("memory-backend-ram,id=mem,size=6144M,prealloc=on");
  const browser = qemuArgs({ ...job, profile: "browser", prepare: false }, 12345);
  expect(browser).toContain("memory-backend-ram,id=mem,size=8192M,prealloc=on");
  expect(browser).toContain("virtio-blk-pci,drive=cache,serial=bunwasmcache");
  expect(browser.join(" ")).not.toMatch(/virtfs|9p|\/home\/shaul/);
});

test("atomic image publication cannot overwrite an existing immutable base", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-image-publication-"));
  try {
    const target = join(directory, baseImage);
    const candidate = join(directory, "candidate.qcow2");
    await writeFile(candidate, "new verified image");
    await publishPreparedImage(candidate, target);
    await writeFile(candidate + ".other", "unaccepted replacement");
    await expect(publishPreparedImage(candidate + ".other", target)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("new verified image");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("guest commands refuse old image contents before running a payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-image-identity-"));
  try {
    const identity = join(directory, "identity");
    const command = guestCommand(["bash", "-c", "printf '%s' \"$ImageVersion\""])
      .replace(imageIdentityPath, identity).replace("cd /work/w/bun-wasm/bun-wasm", `cd ${directory}`);
    await writeFile(identity, "ubuntu-24.04-node26.13.1-v1\n");
    const old = spawnSync("bash", ["-euc", command], { encoding: "utf8" });
    expect(old.status).not.toBe(0);
    expect(old.stdout).toBe("");
    await writeFile(identity, imageVersion + "\n");
    const current = spawnSync("bash", ["-euc", command], { encoding: "utf8" });
    expect(current.status, current.stderr).toBe(0);
    expect(current.stdout).toBe(imageVersion);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
