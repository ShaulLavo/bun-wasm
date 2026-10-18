import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildWasiSysroot, type SysrootOptions } from "../../scripts/build-wasi-sysroot.ts";

// Only a tiny fake builder runs here. Real libc/guest builds belong in the heavy gate.
async function fixture(run: (options: SysrootOptions) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-sysroot-test-"));
  const options = {
    waffle: join(directory, "waffle"), revision: "0".repeat(40),
    sdk: join(directory, "sdk"), output: join(directory, "output"),
    scratch: join(directory, "scratch"),
  };
  try {
    await mkdir(join(options.waffle, "scripts"), { recursive: true });
    await mkdir(join(options.waffle, "patches/wasi-libc"), { recursive: true });
    await mkdir(options.scratch);
    for (const path of ["include/c++", "include/wasm32-wasip1/noeh", "lib/wasm32-wasip1/noeh"]) {
      await mkdir(join(options.sdk, "share/wasi-sysroot", path), { recursive: true });
    }
    await writeFile(join(options.sdk, "VERSION"), "fake SDK for bootstrap tests\n");
    await writeFile(join(options.waffle, "patches/wasi-libc/preopen-scan.patch"), "fixture patch\n");
    await writeFile(join(options.waffle, "scripts/builder.ts"), `
const output = process.argv[2];
await Bun.write(output + "/lib/wasm32-wasip1/libc.a", "fixture patched libc");
`);
    await writeFile(join(options.waffle, "scripts/build-wasi-libc.sh"),
      `#!/usr/bin/env bash\nexec "${process.execPath}" "${join(options.waffle, "scripts/builder.ts")}" "$1"\n`);
    await run(options);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function cleanScratch(options: SysrootOptions) {
  expect(await readdir(options.scratch)).toEqual([]);
  expect(await Bun.file(`${options.output}.lock`).exists()).toBe(false);
  expect((await readdir(resolve(options.output, ".."))).includes("output.lock")).toBe(false);
}

test("sysroot setup publishes patched libc and only SDK C++ overlays, then verifies reuse", async () => {
  await fixture(async options => {
    await buildWasiSysroot(options);
    const libc = join(options.output, "lib/wasm32-wasip1/libc.a");
    expect(await Bun.file(libc).text()).toBe("fixture patched libc");
    const receipt = await Bun.file(join(options.output, "bun-wasm-sysroot.json")).json();
    expect(receipt.waffleRevision).toBe(options.revision);
    expect(receipt.libcSha256).toBe(new Bun.CryptoHasher("sha256").update("fixture patched libc").digest("hex"));
    for (const path of ["include/c++", "include/wasm32-wasip1/noeh", "lib/wasm32-wasip1/noeh"]) {
      expect(await readlink(join(options.output, path))).toBe(join(options.sdk, "share/wasi-sysroot", path));
    }
    // A rerun must verify the receipt, not invoke the builder again.
    await writeFile(join(options.waffle, "scripts/builder.ts"), "process.exit(99);\n");
    await buildWasiSysroot(options);
    expect(await Bun.file(libc).text()).toBe("fixture patched libc");
    await cleanScratch(options);
  });
});

test("sysroot setup refuses changed pinned inputs and corrupted libc without replacing output", async () => {
  await fixture(async options => {
    await buildWasiSysroot(options);
    await expect(buildWasiSysroot({ ...options, revision: "1".repeat(40) })).rejects.toThrow("Sysroot inputs changed");
    const libc = join(options.output, "lib/wasm32-wasip1/libc.a");
    await writeFile(libc, "caller changed libc");
    await expect(buildWasiSysroot(options)).rejects.toThrow("Sysroot inputs changed");
    expect(await Bun.file(libc).text()).toBe("caller changed libc");
    await cleanScratch(options);
  });
});

test("sysroot setup removes its failed stage and claim but preserves pre-existing outputs", async () => {
  await fixture(async options => {
    await writeFile(join(options.waffle, "scripts/builder.ts"), "process.exit(3);\n");
    await expect(buildWasiSysroot(options)).rejects.toThrow("exited 3");
    await cleanScratch(options);
    expect((await readdir(resolve(options.output, ".."))).includes("output")).toBe(false);
    await mkdir(options.output);
    await writeFile(join(options.output, "owner-data"), "preserve me");
    await expect(buildWasiSysroot(options)).rejects.toThrow("Refusing to replace existing sysroot");
    expect(await Bun.file(join(options.output, "owner-data")).text()).toBe("preserve me");
    await cleanScratch(options);
  });
});

test("sysroot setup never steals or removes another builder's claim", async () => {
  await fixture(async options => {
    await mkdir(`${options.output}.lock`);
    await writeFile(join(`${options.output}.lock`, "owner-data"), "another build");
    await expect(buildWasiSysroot(options)).rejects.toThrow();
    expect(await Bun.file(join(`${options.output}.lock`, "owner-data")).text()).toBe("another build");
    expect(await readdir(options.scratch)).toEqual([]);
  });
});

test("sysroot setup rejects malformed receipts without modifying caller data", async () => {
  await fixture(async options => {
    await mkdir(options.output);
    const receipt = join(options.output, "bun-wasm-sysroot.json");
    await writeFile(receipt, "not JSON");
    await expect(buildWasiSysroot(options)).rejects.toThrow();
    expect(await Bun.file(receipt).text()).toBe("not JSON");
    await cleanScratch(options);
  });
});

test("sysroot interruption terminates its builder and removes only owned stage and claim", async () => {
  await fixture(async options => {
    const started = join(options.scratch, "started");
    await writeFile(join(options.waffle, "scripts/builder.ts"), `
await Bun.write(${JSON.stringify(started)}, String(process.pid));
setInterval(() => {}, 1000);
`);
    const driver = join(options.waffle, "scripts/driver.ts");
    await writeFile(driver, `import { buildWasiSysroot } from ${JSON.stringify(resolve(import.meta.dir, "../../scripts/build-wasi-sysroot.ts"))};\nawait buildWasiSysroot(${JSON.stringify(options)});\n`);
    const child = Bun.spawn([process.execPath, driver], { stdout: "ignore", stderr: "pipe" });
    try {
      for (let attempt = 0; attempt < 500 && !await Bun.file(started).exists(); attempt++) await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);
      const builderPid = Number(await Bun.file(started).text());
      child.kill("SIGTERM");
      expect(await child.exited).not.toBe(0);
      expect(() => process.kill(builderPid, 0)).toThrow();
      await rm(started);
      await cleanScratch(options);
    } finally {
      if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    }
  });
});
