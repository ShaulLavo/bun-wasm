import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

const PAGE_BYTES = 65536;

const MAX_MEMORY_FILE = "max-memory.txt";
const GROUP_ADDRESS_SPACE_FILE = "group-address-space.txt";

/**
 * One line of decimal bytes: a page multiple, at most 2 GiB (browser hosts still read i32
 * addresses as signed above that). Mirrors `parse` in crates/bunwasm-cli/max_memory.rs, the one
 * Rust parser of both authority files.
 */
function parseMemoryAuthority(text: string, file: string): number {
  if (!/^[0-9]+\n$/.test(text)) throw new Error(`${file} holds one line of decimal bytes`);
  const bytes = Number(text.slice(0, -1));
  if (bytes <= 0 || bytes % PAGE_BYTES !== 0 || bytes > 2 ** 31) throw new Error(`${file} must be a page multiple in (0, 2 GiB]`);
  return bytes;
}

export function parseMaxMemory(text: string): number {
  return parseMemoryAuthority(text, MAX_MEMORY_FILE);
}

/** The group address space holds at least what the guest memory maximum lets its members use. */
export function parseGroupAddressSpace(text: string, maxMemory: number): number {
  const bytes = parseMemoryAuthority(text, GROUP_ADDRESS_SPACE_FILE);
  if (bytes < maxMemory) throw new Error(`${GROUP_ADDRESS_SPACE_FILE} must hold at least the guest memory maximum`);
  return bytes;
}

/**
 * The wasm32 memory maximum of every Bun guest, from its one authority (docs/memory-ceiling.md):
 * split links, engine heap sizing, and the pages a group's members may hold together.
 */
export function maxMemoryBytes(): number {
  return parseMaxMemory(readFileSync(join(ROOT, "crates/bunwasm-cli", MAX_MEMORY_FILE), "utf8"));
}

/** The address space of one shared-group memory, from its one authority (docs/memory-ceiling.md, stage 2). */
export function groupAddressSpaceBytes(): number {
  return parseGroupAddressSpace(readFileSync(join(ROOT, "crates/bunwasm-cli", GROUP_ADDRESS_SPACE_FILE), "utf8"), maxMemoryBytes());
}

/** The page maximum a shared-group core and its side declare for the imported group memory. */
export function sharedGroupMaxPages(): number {
  return groupAddressSpaceBytes() / PAGE_BYTES;
}

/** The pages the members of one group may hold together: the guest memory maximum. Regions are not counted. */
export function sharedGroupMemberPages(): number {
  return maxMemoryBytes() / PAGE_BYTES;
}

/** The core's exact link arguments, in crates/bunwasm-cli/build.rs order. */
export function sharedGroupCoreLink(): string[] {
  const list = readFileSync(join(ROOT, "crates/bunwasm-cli/shared-group-link.txt"), "utf8").split("\n").filter(Boolean);
  return [`--max-memory=${groupAddressSpaceBytes()}`].concat(list);
}

/**
 * A side's exact link arguments, in producer order. Without `--max-memory`, wasm-ld gives a
 * shared PIC image the whole wasm32 space (65536 pages), which import matching would accept
 * for any narrower group memory. The side declares the group address space itself, so a side
 * linked for another stage is refused like its core.
 */
export function sharedGroupSideLink(): string[] {
  return ["--shared", "--shared-memory", `--max-memory=${groupAddressSpaceBytes()}`, "--Bsymbolic", "--no-export-dynamic", "--gc-sections", "--no-entry",
    "--import-memory=env,memory", "--import-table", "--allow-undefined"];
}

export const SHARED_GROUP_OPTIMIZER = ["-O2", "-g", "--strip-dwarf", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext",
  "--enable-mutable-globals", "--enable-threads"] as const;

/** Compiler environment for every guest object of a shared-group program. */
export function sharedGroupEnvironment(sysroot: string, kind: "core" | "quickjs" | "jsc"): Record<string, string> {
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

interface CxxRuntimeMember {
  readonly archive: string;
  readonly member: string;
  readonly sha256: string;
  readonly features: readonly string[];
}

/** Every libc++/libc++abi archive member a link map shows was selected into the image. */
export function selectedCxxMembers(map: string): { archive: string; member: string }[] {
  const selected = new Map<string, { archive: string; member: string }>();
  for (const match of map.matchAll(/(\S*\/libc\+\+(?:abi)?\.a)\(([^)]+)\)/g)) {
    selected.set(`${match[1]}(${match[2]})`, { archive: match[1]!, member: match[2]! });
  }
  return Array.from(selected.values());
}

/** The `target_features` custom section of one object file, with its +/-/= prefixes. */
export function targetFeatures(bytes: Uint8Array): string[] {
  const cursor = { at: 8 };
  const read = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[cursor.at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
  };
  const text = () => {
    const length = read();
    cursor.at += length;
    return new TextDecoder().decode(bytes.subarray(cursor.at - length, cursor.at));
  };
  while (cursor.at < bytes.length) {
    const id = bytes[cursor.at++];
    const end = read() + cursor.at;
    if (id === 0 && text() === "target_features") return Array.from({ length: read() }, () => String.fromCharCode(bytes[cursor.at++]!) + text());
    cursor.at = end;
  }
  return [];
}

/** Record the selected C++ runtime members; one that disallows shared memory is refused. */
function linkProof(mapPath: string, output: string): void {
  const ar = join(process.env.WASI_SDK_PATH ?? "", "bin/llvm-ar");
  const members: CxxRuntimeMember[] = selectedCxxMembers(readFileSync(mapPath, "utf8")).map(({ archive, member }) => {
    const extracted = Bun.spawnSync([ar, "p", archive, member], { stdout: "pipe", stderr: "inherit" });
    if (extracted.exitCode !== 0) throw new Error(`cannot read ${archive}(${member})`);
    const bytes = extracted.stdout;
    return { archive, member, sha256: sha256(bytes), features: targetFeatures(bytes) };
  });
  const refused = members.filter(member => member.features.includes("-shared-mem"));
  if (refused.length) throw new Error(`C++ runtime members disallow shared memory: ${refused.map(member => member.member).join(", ")}`);
  writeFileSync(output, JSON.stringify(members, null, 2) + "\n");
}

if (import.meta.main) {
  const [command, kind, output] = process.argv.slice(2);
  // Shell consumers read the maximum here, so they get the same validation before they configure or link.
  if (command === "max-memory" && !kind) {
    console.log(maxMemoryBytes());
    process.exit(0);
  }
  // A shared-group side links at the group address space, never at the guest memory maximum.
  if (command === "group-address-space" && !kind) {
    console.log(groupAddressSpaceBytes());
    process.exit(0);
  }
  if (command === "link-proof" && kind && output) {
    linkProof(kind, output);
    process.exit(0);
  }
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (command !== "environment" || (kind !== "core" && kind !== "quickjs" && kind !== "jsc") || !sysroot) throw new Error("Usage: BUN_WASM_SYSROOT=... program-profile.ts environment core|quickjs|jsc | link-proof MAP OUTPUT | max-memory | group-address-space");
  if (process.env.BUN_WASM_SHARED_SYSROOT !== sysroot) throw new Error("shared-group builds set BUN_WASM_SHARED_SYSROOT and BUN_WASM_SYSROOT to the same J2 sysroot");
  verifySharedSysroot(sysroot);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  console.log("unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS\n" + Object.entries(sharedGroupEnvironment(sysroot, kind)).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n"));
}
