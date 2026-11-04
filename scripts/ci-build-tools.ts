import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

// The JSC inputs stamp and the sysroot receipt fingerprint CMake and Ninja. Hosted runner
// images roll out gradually, so the jobs of one run can get different preinstalled versions
// (run 41803538617: cmake 4.4.5 in the producer, 4.4.4 in its consumer). Every job that
// produces or checks those fingerprints installs these exact bytes where env.sh looks first.
export const buildToolPins = [
  {
    name: "cmake",
    url: "https://github.com/Kitware/CMake/releases/download/v4.4.5/cmake-4.4.5-linux-x86_64.tar.gz",
    archive: "cmake-4.4.5-linux-x86_64.tar.gz",
    sha256: "ed85135c5a5135b45e50423cb406dea04ca3338da0b8ef3c9ede963559680be0",
    bin: "bin",
    toolVersion: "cmake version 4.4.5",
  },
  {
    name: "ninja",
    url: "https://github.com/ninja-build/ninja/releases/download/v1.13.2/ninja-linux.zip",
    archive: "ninja-1.13.2-linux.zip",
    sha256: "5749cbc4e668273514150a80e387a957f933c6ed3f5f11e03fb30955e2bbead6",
    bin: ".",
    toolVersion: "1.13.2",
  },
] as const;
type Pin = typeof buildToolPins[number];

export async function verifyBuildToolArchive(pin: Pin, path: string): Promise<void> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  if (digest.digest("hex") !== pin.sha256) throw new Error(`${pin.name} archive checksum mismatch: ${path}`);
}

function extract(pin: Pin, archive: string, prefix: string): void {
  if (pin.archive.endsWith(".zip")) execFileSync("unzip", ["-q", archive, "-d", prefix]);
  else execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", prefix]);
}

async function installPin(tools: string, stage: string, pin: Pin) {
  const archive = join(tools, pin.archive);
  const cached = await Bun.file(archive).exists();
  const input = cached ? archive : join(stage, pin.archive);
  if (!cached) {
    execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "15", "--max-time", "300", pin.url, "-o", input]);
  }
  await verifyBuildToolArchive(pin, input);
  if (!cached) await rename(input, archive);
  const prefix = join(stage, pin.name);
  await mkdir(prefix);
  extract(pin, archive, prefix);
  const executable = join(prefix, pin.bin, pin.name);
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).split("\n")[0]!.trim();
  if (version !== pin.toolVersion) throw new Error(`Unexpected ${pin.name} version: ${version}`);
  const destination = join(tools, pin.name);
  await rm(destination, { recursive: true, force: true });
  await rename(prefix, destination);
  return { name: pin.name, bin: join(destination, pin.bin), cached, version, archiveSha256: pin.sha256 };
}

export async function installBuildTools(tools: string) {
  await mkdir(tools, { recursive: true });
  const stage = await mkdtemp(join(tools, ".build-tools-"));
  try {
    const results = [];
    for (const pin of buildToolPins) results.push(await installPin(tools, stage, pin));
    return results;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const tools = process.env.WASM_TOOLS;
  const githubPath = process.env.GITHUB_PATH;
  if (!tools || !githubPath) throw new Error("Set WASM_TOOLS and GITHUB_PATH for CI build tool setup");
  const results = await installBuildTools(tools);
  // Steps that do not source env.sh (host tool identity, Cargo build scripts) see the same tools.
  await appendFile(githubPath, results.map(result => `${result.bin}\n`).join(""));
  process.stdout.write(JSON.stringify(results) + "\n");
}
