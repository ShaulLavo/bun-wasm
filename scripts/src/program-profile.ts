import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Program build profiles. `split` is the existing engine-split profile and is never recorded in a
 * receipt, so its inputs and artifacts are unchanged. `shared-group` is the opt-in memory-group
 * member profile: a PIE core and an atomics side over one imported shared memory.
 * Contract: docs/shared-group-profile.md.
 */
export type ProgramProfile = "split" | "shared-group";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const C_FEATURES = "-fPIC -matomics -mbulk-memory -mmutable-globals";

/** Bun's wasm32 string tags use address bits 29-31, so a member's group stays below 512 MiB. */
export const SHARED_GROUP_MAX_PAGES = 8192;

/** The core's exact link arguments, shared with crates/bunwasm-cli/build.rs. */
export function sharedGroupCoreLink(): string[] {
  return readFileSync(join(ROOT, "crates/bunwasm-cli/shared-group-link.txt"), "utf8").split("\n").filter(Boolean);
}

export const SHARED_GROUP_SIDE_LINK = ["--shared", "--shared-memory", "--Bsymbolic", "--no-export-dynamic", "--gc-sections", "--no-entry",
  "--import-memory=env,memory", "--import-table", "--allow-undefined"] as const;

export const SHARED_GROUP_OPTIMIZER = ["-O2", "-g", "--strip-dwarf", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext",
  "--enable-mutable-globals", "--enable-threads"] as const;

/** Compiler environment for every guest object of a shared-group program. */
export function sharedGroupEnvironment(sysroot: string, kind: "core" | "quickjs"): Record<string, string> {
  const environment: Record<string, string> = {
    BUN_WASM_PROGRAM_PROFILE: "shared-group",
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS: `--cap-lints=warn -C relocation-model=pic -C target-feature=+atomics,+bulk-memory,+mutable-globals -C panic=abort -C link-self-contained=no -L native=${sysroot}/lib/wasm32-wasip1`,
    CFLAGS_wasm32_wasip1: `--sysroot=${sysroot} ${C_FEATURES}`,
    CXXFLAGS_wasm32_wasip1: `--sysroot=${sysroot} ${C_FEATURES} -fno-exceptions`,
  };
  if (kind === "quickjs") environment.RQUICKJS_SYS_NO_WASI_SDK = "1";
  return environment;
}

export interface SharedSysrootIdentity {
  readonly receiptSha256: string;
  readonly libcSha256: string;
  readonly sharedBuilderSha256: string;
  readonly groupGrowPatchSha256: string;
}

const J2_FLAGS = "-fPIC -matomics -mbulk-memory -mmutable-globals -DMORECORE_CONTIGUOUS=0 -DBUN_WASM_GROUP_HEAP=1";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** The J2 PIC+atomics sysroot is the only libc a shared-group program may link. */
export function verifySharedSysroot(sysroot: string): SharedSysrootIdentity {
  const receiptBytes = readFileSync(join(sysroot, "bun-wasm-sysroot.json"));
  const receipt: unknown = JSON.parse(receiptBytes.toString("utf8"));
  if (!receipt || typeof receipt !== "object" || !("profile" in receipt) || receipt.profile !== "shared-pic") throw new Error("shared-group requires the shared-pic sysroot");
  if (!("growthImport" in receipt) || receipt.growthImport !== "runtime_shm.group_grow" || !("flags" in receipt) || receipt.flags !== J2_FLAGS) throw new Error("shared-pic sysroot growth import or flags differ from the J2 contract");
  const { libcSha256, sharedBuilderSha256, groupGrowPatchSha256 } = receipt as Record<string, unknown>;
  if (!digest(libcSha256) || !digest(sharedBuilderSha256) || !digest(groupGrowPatchSha256)) throw new Error("Invalid shared-pic sysroot receipt");
  if (sha256(readFileSync(join(sysroot, "lib/wasm32-wasip1/libc.a"))) !== libcSha256) throw new Error("shared-pic libc bytes do not match their receipt");
  return { receiptSha256: sha256(receiptBytes), libcSha256, sharedBuilderSha256, groupGrowPatchSha256 };
}

/** A split build never reads the shared-pic sysroot, so one profile's libc cannot leak into the other. */
export function verifySplitSysroot(sysroot: string): void {
  const receipt: unknown = JSON.parse(readFileSync(join(sysroot, "bun-wasm-sysroot.json"), "utf8"));
  if (receipt && typeof receipt === "object" && "profile" in receipt) throw new Error("split programs require the default patched sysroot");
}

export function parseProgramProfile(value: unknown): ProgramProfile {
  if (value === undefined || value === "split") return "split";
  if (value === "shared-group") return value;
  throw new Error("Invalid program profile");
}

if (import.meta.main) {
  const [command, kind] = process.argv.slice(2);
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (command !== "environment" || (kind !== "core" && kind !== "quickjs") || !sysroot) throw new Error("Usage: BUN_WASM_SYSROOT=... program-profile.ts environment core|quickjs");
  if (process.env.BUN_WASM_SHARED_SYSROOT !== sysroot) throw new Error("shared-group builds set BUN_WASM_SHARED_SYSROOT and BUN_WASM_SYSROOT to the same J2 sysroot");
  verifySharedSysroot(sysroot);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  console.log("unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS\n" + Object.entries(sharedGroupEnvironment(sysroot, kind)).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n"));
}
