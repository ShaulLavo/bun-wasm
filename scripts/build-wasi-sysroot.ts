// Consumer-owned sysroot: Waffle owns the only wasi-libc source patch and builder.
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = async (path: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return false;
  }
}

export interface SysrootOptions {
  readonly waffle: string;
  readonly revision: string;
  readonly sdk: string;
  readonly output: string;
  readonly scratch: string;
}

export async function buildWasiSysroot(options: SysrootOptions): Promise<void> {
  const { waffle, revision, sdk, output, scratch } = options;
  const builder = join(waffle, "scripts/build-wasi-libc.sh");
  const inputs = {
    waffleRevision: revision,
    sdkVersion: await readFile(join(sdk, "VERSION"), "utf8"),
    builderSha256: await hash(builder),
    patchSha256: await hash(join(waffle, "patches/wasi-libc/preopen-scan.patch")),
  };
  const receiptPath = join(output, "bun-wasm-sysroot.json");
  if (await Bun.file(receiptPath).exists()) {
    const receipt = await Bun.file(receiptPath).json();
    const expected = { ...inputs, libcSha256: await hash(join(output, "lib/wasm32-wasip1/libc.a")) };
    if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error(`Sysroot inputs changed: choose a new BUN_WASM_SYSROOT; refusing to replace ${output}`);
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
    stage = await mkdtemp(join(scratch, "bun-wasm-sysroot-"));
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
    const stock = join(sdk, "share/wasi-sysroot");
    for (const path of ["include/c++", "include/wasm32-wasip1/noeh", "lib/wasm32-wasip1/noeh"]) {
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
  const manifest = await Bun.file(join(root, "package.json")).json();
  const revision = manifest.devDependencies.waffle.split("#")[1];
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Waffle must be pinned to an exact merged commit");
  const waffle = dirname(Bun.resolveSync("waffle/package.json", root));
  await buildWasiSysroot({ waffle, revision, sdk, output, scratch: process.env.TMPDIR ?? "/work/tmp" });
}
