import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyGuestBuildReceipt } from "./guest-build-receipt";

const root = resolve(import.meta.dir, "..");
const fixtures = ["astro-http2-response", "tests/fixtures/shared-array-buffer", "tests/jsc-embedding/growable-memory"];
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function git(...args: string[]): string {
  return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim();
}

function inputs() {
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("JSC embedding source must be committed and clean");
  const build = process.env.JSC_BUILD_DIR;
  if (!build) throw new Error("Set JSC_BUILD_DIR to the validated prebuild");
  execFileSync("bash", ["-c", 'source "$1/jsc/common.sh"; check_jsc_inputs_stamp', "jsc-inputs", root], { stdio: ["ignore", "ignore", "inherit"] });
  return {
    sourceHead: git("rev-parse", "HEAD"),
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    jscInputsSha256: readFileSync(join(build, "build/jsc/.bunwasm-inputs"), "utf8").trim(),
    archives: ["build/jsc/lib/libJavaScriptCore.a", "build/jsc/lib/libWTF.a", "build/jsc/lib/libbmalloc.a", "icu/prefix/lib/libicuuc.a", "icu/prefix/lib/libicui18n.a", "icu/prefix/lib/libicudata.a", "shim/libwasi-compat.a"]
      .map(path => ({ path, sha256: hash(readFileSync(join(build, path))) })),
  };
}

export function verifyEmbeddingReceipt(value: unknown, expected: ReturnType<typeof inputs>, bytes: Uint8Array): void {
  const receipt = { ...expected, artifactSha256: hash(bytes), artifactBytes: bytes.byteLength };
  if (JSON.stringify(value) !== JSON.stringify(receipt)) throw new Error("JSC embedding source/prebuild/artifact receipt mismatch");
}

function testFixtures(artifact: string): void {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-jsc-embedding-"));
  try {
    for (const fixture of fixtures) runFixture(artifact, fixture, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runFixture(artifact: string, fixture: string, scratch: string): void {
  const source = join(root, fixture);
  const work = join(scratch, fixture);
  cpSync(source, work, { recursive: true });
  const run = spawnSync("node", ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--wasm", artifact,
    "--engine", `jsc=${artifact}`, "--dir", `${work}::/`, "--env", "PATH=/opt/bun/jsc/bin:/bin:/usr/bin", "--env", "PWD=/", "--env", "HOME=/", "--env", "BUNWASM_TEST=1", "--", "run", "/index.ts"],
  { cwd: work, encoding: "utf8", timeout: 60_000, env: { ...process.env, BUN_WASM_SCRATCH_ROOT: scratch, TMPDIR: scratch, AGENT: "0", CLAUDECODE: "" } });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.error) throw run.error;
  if (run.status !== 0 || run.stdout !== readFileSync(join(source, "expected.txt"), "utf8")) {
    throw new Error(`JSC fixture ${fixture} failed, exit ${run.status}, signal ${run.signal}`);
  }
  console.log(`PASS JSC ${fixture}`);
}

if (import.meta.main) {
  const [command, artifactName, snapshot] = process.argv.slice(2);
  const current = inputs();
  if (command === "inputs") {
    console.log(JSON.stringify(current));
  } else if (command === "write" && artifactName && snapshot) {
    if (JSON.stringify(current) !== snapshot) throw new Error("JSC embedding inputs changed during build");
    const bytes = await Bun.file(artifactName).bytes();
    await Bun.write(`${artifactName}.embedding.json`, JSON.stringify({ ...current, artifactSha256: hash(bytes), artifactBytes: bytes.byteLength }));
  } else if (command === "test" && artifactName) {
    const artifact = resolve(artifactName);
    const bytes = await Bun.file(artifact).bytes();
    verifyEmbeddingReceipt(await Bun.file(`${artifact}.embedding.json`).json(), current, bytes);
    verifyGuestBuildReceipt(bytes, await Bun.file(`${artifact}.build.json`).json());
    console.log(`JSC source ${current.sourceHead}; guest sha256 ${hash(bytes)}`);
    testFixtures(artifact);
  } else {
    throw new Error("Usage: jsc-embedding.ts inputs | write ARTIFACT INPUTS_JSON | test ARTIFACT");
  }
}
