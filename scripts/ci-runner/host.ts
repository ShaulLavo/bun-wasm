import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, copyFile, mkdir, rename, rm, statfs } from "node:fs/promises";
import { resolve } from "node:path";

export const root = "/work/ci-runner/bun-wasm";

export function command(argv: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}): string {
  const executable = argv[0];
  if (!executable) throw new Error("Missing executable");
  const result = spawnSync(executable, argv.slice(1), { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, ...options });
  if (result.status !== 0) throw new Error(`${executable} failed with status ${result.status}, signal ${result.signal}`);
  return result.stdout;
}

export async function verifyStorage(): Promise<void> {
  if (command(["findmnt", "-n", "-o", "TARGET,FSTYPE", "-T", "/work"]).trim() !== "/work xfs") throw new Error("Expected mounted XFS /work");
  const stats = await statfs("/work");
  if (stats.bavail * stats.bsize < 20 * 1024 ** 3) throw new Error("Need 20 GiB logical free on /work");
}

export async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function download(url: string, destination: string, sha256: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !url.startsWith("https://")) throw new Error("Invalid download identity");
  await verifyStorage();
  if (await digest(destination).catch(() => "") === sha256) return;
  const partial = `${destination}.partial`;
  try {
    command(["curl", "--fail", "--silent", "--show-error", "--location", "--connect-timeout", "20", "--max-time", "900", "--retry", "2", "--output", partial, url], { timeout: 2_800_000 });
    if (await digest(partial) !== sha256) throw new Error("Download checksum mismatch");
    await rename(partial, destination);
  } finally {
    await rm(partial, { force: true });
  }
}

export function toolEnvironment(): NodeJS.ProcessEnv {
  return { PATH: `${root}/tools/usr/bin:/usr/bin:/bin`, LD_LIBRARY_PATH: `${root}/tools/usr/lib`, HOME: root, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}` };
}

async function install(): Promise<void> {
  await verifyStorage();
  if (process.getuid?.() !== 1000) throw new Error("Run as shaul, uid 1000");
  command(["python3", "-c", 'import os,fcntl; f=os.open("/dev/kvm",os.O_RDWR); assert fcntl.ioctl(f,0xAE00)==12; os.close(f)']);
  for (const directory of ["downloads", "tools", "images", "jobs", "cache", "bin"]) await mkdir(`${root}/${directory}`, { recursive: true });
  const packages = command(["pacman", "-Sp", "--print-format", "%h %l", "qemu-system-x86", "qemu-img", "dosfstools", "mtools"]);
  for (const line of packages.trim().split("\n")) {
    const [sha256, url] = line.split(" ");
    if (!sha256 || !url) throw new Error("Invalid pacman package metadata");
    const archive = `${root}/downloads/${url.slice(url.lastIndexOf("/") + 1)}`;
    await download(url, archive, sha256);
    command(["tar", "-xf", archive, "-C", `${root}/tools`, "--no-same-owner"]);
    await rm(archive);
  }
  await download("https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img", `${root}/images/ubuntu-noble.qcow2`, "04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94");
  await copyFile(process.execPath, `${root}/bin/bun`);
  await copyFile(command(["which", "gh"]).trim(), `${root}/bin/gh`);
  await cp(new URL(".", import.meta.url).pathname, `${root}/source`, { recursive: true });
  process.stdout.write(command([`${root}/tools/usr/bin/qemu-system-x86_64`, "--version"], { env: toolEnvironment() }));
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  install().catch(() => { process.stderr.write("PC runner host preparation failed; no registration was attempted.\n"); process.exitCode = 1; });
}
