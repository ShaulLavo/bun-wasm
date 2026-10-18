import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export interface GuestBuildInputs {
  readonly bunHead: string;
  readonly bunTree: string;
  readonly sysrootReceiptSha256: string;
}

export interface GuestBuildReceipt extends GuestBuildInputs {
  readonly artifactSha256: string;
  readonly artifactBytes: number;
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(`Guest source check failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function readInputs(repository: string, sysroot: string): Promise<GuestBuildInputs> {
  const git = ["git", "-C", join(repository, "vendor/bun")];
  if (run(git.concat(["status", "--porcelain", "--untracked-files=normal"]))) {
    throw new Error("Guest source changed during the build: vendor/bun has local changes");
  }
  return {
    bunHead: run(git.concat(["rev-parse", "HEAD"])),
    bunTree: run(git.concat(["rev-parse", "HEAD^{tree}"])),
    sysrootReceiptSha256: sha256(await Bun.file(join(sysroot, "bun-wasm-sysroot.json")).bytes()),
  };
}

export async function prepareGuestBuildInputs(repository: string, sysroot: string): Promise<GuestBuildInputs> {
  // This is the single patch-tree check before guest compilation; never repair
  // imported source as a side effect of a build.
  run(["bash", join(repository, "scripts/sync-bun.sh"), "--check"]);
  return readInputs(repository, sysroot);
}

export async function writeGuestBuildReceipt(repository: string, sysroot: string, artifact: string, inputs: GuestBuildInputs): Promise<GuestBuildReceipt> {
  const current = await readInputs(repository, sysroot);
  if (JSON.stringify(current) !== JSON.stringify(inputs)) throw new Error("Guest source or sysroot receipt changed during the build");
  const bytes = await Bun.file(artifact).bytes();
  const receipt = { ...inputs, artifactSha256: sha256(bytes), artifactBytes: bytes.byteLength };
  await Bun.write(`${artifact}.build.json`, JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

// Publication and browser acceptance use the same sidecar, not a second build
// identity. This validates its schema and binds it to the exact artifact bytes.
export function verifyGuestBuildReceipt(bytes: Uint8Array, value: unknown): asserts value is GuestBuildReceipt {
  if (!value || typeof value !== "object") throw new Error("Invalid guest build receipt");
  const receipt = value as Record<string, unknown>;
  for (const [field, length] of [["bunHead", 40], ["bunTree", 40], ["sysrootReceiptSha256", 64], ["artifactSha256", 64]] as const) {
    if (typeof receipt[field] !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(receipt[field])) throw new Error(`Invalid guest build receipt: ${field}`);
  }
  if (receipt.artifactBytes !== bytes.byteLength || receipt.artifactSha256 !== sha256(bytes)) throw new Error("Guest build receipt does not match artifact bytes");
}

if (import.meta.main) {
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (!sysroot) throw new Error("Source env.sh before building a guest");
  const [command, artifact, inputs] = process.argv.slice(2);
  if (command === "inputs") {
    console.log(JSON.stringify(await prepareGuestBuildInputs(root, sysroot)));
  } else if (command === "write" && artifact && inputs) {
    await writeGuestBuildReceipt(root, sysroot, artifact, JSON.parse(inputs));
  } else {
    throw new Error("Usage: guest-build-receipt.ts inputs | write ARTIFACT INPUTS_JSON");
  }
}
