// Consumer-owned sysroot: Waffle owns the only wasi-libc source patch and builder.
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasedWaffleNativeInputs } from "./waffle-release-inputs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = async (path: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return false;
  }
}

async function toolInput(command: string) {
  const path = await realpath(command);
  const result = Bun.spawnSync([command, "--version"], { stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(`Sysroot tool probe failed: ${command}`);
  return { path, sha256: await hash(path), version: result.stdout.toString() + result.stderr.toString() };
}

export interface SysrootOptions {
  readonly waffle: string;
  readonly sdk: string;
  readonly output: string;
}

export async function wasiSysrootInputs(options: Omit<SysrootOptions, "output">) {
  const { waffle, sdk } = options;
  const overlays = ["include/c++", "include/wasm32-wasip1/noeh", "lib/wasm32-wasip1/noeh"];
  const stock = join(sdk, "share/wasi-sysroot");
  const builder = join(waffle, "scripts/build-wasi-libc.sh");
  // Package revisions are provenance, not build inputs: proc-only Waffle changes
  // must not invalidate libc or its ICU/JSC consumers. The installed builder pins
  // the libc source revision and archive hash in its own content.
  const tools = await Promise.all(["clang", "llvm-ar", "llvm-nm", "llvm-ranlib"].map(name => toolInput(join(sdk, "bin", name)))
    .concat(["cmake", "ninja"].map(name => {
      const path = Bun.which(name);
      if (!path) throw new Error(`Missing sysroot build tool: ${name}`);
      return toolInput(path);
    })));
  const sdkOverlays = await Promise.all(overlays.map(async path => ({ path, target: await realpath(join(stock, path)) })));
  const environment = Object.fromEntries(["CFLAGS", "CXXFLAGS", "ASMFLAGS", "CPPFLAGS", "LDFLAGS", "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH", "SDKROOT"]
    .map(name => [name, process.env[name] ?? ""]));
  return {
    sdkVersion: await readFile(join(sdk, "VERSION"), "utf8"),
    builderSha256: await hash(builder),
    patchSha256: await hash(join(waffle, "patches/wasi-libc/preopen-scan.patch")),
    tools, sdkOverlays, environment,
  };
}

export async function buildWasiSysroot(options: SysrootOptions): Promise<void> {
  const { waffle, sdk, output } = options;
  const overlays = ["include/c++", "include/wasm32-wasip1/noeh", "lib/wasm32-wasip1/noeh"];
  const stock = join(sdk, "share/wasi-sysroot");
  const builder = join(waffle, "scripts/build-wasi-libc.sh");
  const inputs = await wasiSysrootInputs(options);
  const receiptPath = join(output, "bun-wasm-sysroot.json");
  if (await Bun.file(receiptPath).exists()) {
    const receipt = await Bun.file(receiptPath).json();
    const expected = { ...inputs, libcSha256: await hash(join(output, "lib/wasm32-wasip1/libc.a")) };
    if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error(`Sysroot inputs changed: choose a new BUN_WASM_SYSROOT; refusing to replace ${output}`);
    for (const path of overlays) {
      const expected = await realpath(join(stock, path));
      const actual = await realpath(join(output, path)).catch(() => undefined);
      if (actual !== expected) throw new Error(`Sysroot SDK overlay changed at ${path}: choose a new BUN_WASM_SYSROOT; refusing to replace ${output}`);
    }
    console.log(`Patched Bun sysroot verified: ${output}`);
    return;
  }
  // mkdir is the inter-process claim. Never steal a lock or replace an existing output.
  await mkdir(dirname(output), { recursive: true });
  const lock = `${output}.lock`;
  let lockOwned = false;
  let stage: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let interrupted = false;
  const stop = () => { interrupted = true; child?.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await mkdir(lock);
    lockOwned = true;
    if (interrupted) throw new Error("Sysroot setup interrupted");
    if (await Bun.file(receiptPath).exists()) throw new Error(`Sysroot appeared during setup: rerun to verify ${output}`);
    // Existing directories, even incomplete ones, remain caller-owned.
    if (await exists(output)) throw new Error(`Refusing to replace existing sysroot: ${output}`);
    // Stage on the destination filesystem so publication cannot cross mounts (EXDEV).
    stage = await mkdtemp(join(dirname(output), ".bun-wasm-sysroot-"));
    const built = join(stage, "sysroot");
    child = Bun.spawn(["bash", builder, built], {
      cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, WASI_SDK_PATH: sdk, WASI_LIBC_SCRATCH_ROOT: stage },
    });
    const status = await child.exited;
    child = undefined;
    if (interrupted || status !== 0) throw new Error(`Pinned Waffle libc build ${interrupted ? "interrupted" : `exited ${status}`}`);
    // These are unchanged SDK C++ inputs, not a second libc search path. The target
    // headers include __config_site; libc/CRT and all emulation archives stay patched.
    for (const path of overlays) {
      await mkdir(dirname(join(built, path)), { recursive: true });
      await symlink(join(stock, path), join(built, path), "dir");
    }
    const receipt = { ...inputs, libcSha256: await hash(join(built, "lib/wasm32-wasip1/libc.a")) };
    await Bun.write(join(built, "bun-wasm-sysroot.json"), JSON.stringify(receipt));
    if (interrupted) throw new Error("Sysroot publication interrupted");
    await rename(built, output);
    console.log(`Patched Bun sysroot ready: ${output}`);
  } finally {
    // Waffle's builder stops its owned compiler process group before it exits.
    if (child) { child.kill("SIGTERM"); await child.exited; }
    if (stage) await rm(stage, { recursive: true, force: true });
    if (lockOwned) await rm(lock, { recursive: true });
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) {
  const sdk = process.env.WASI_SDK_PATH;
  const output = process.env.BUN_WASM_SYSROOT;
  if (!sdk || !output) throw new Error("Source env.sh before building the guest sysroot");
  const waffle = await releasedWaffleNativeInputs(root);
  if (process.argv.includes("--inputs")) {
    const inputs = await wasiSysrootInputs({ waffle, sdk });
    console.log(new Bun.CryptoHasher("sha256").update(JSON.stringify(inputs)).digest("hex"));
  } else {
    await buildWasiSysroot({ waffle, sdk, output });
  }
}
