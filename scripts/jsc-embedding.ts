import { programKind, verifyProgramSide, type ProgramFiles } from "../src/engine-kind.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { artifactIdentity, verifyGuestBuildReceipt, verifyGuestCompanions } from "./guest-build-receipt";
import { nodeHost, parserReserveControls } from "./jsc-parser-reserve";
import { parseCheck } from "./test-checks";

const root = resolve(import.meta.dir, "..");
const fixtures = ["tests/fixtures/astro-http2-response", "tests/fixtures/shared-array-buffer", "tests/fixtures/strings-above-512mib", "tests/fixtures/parser-literal-overflow", "tests/jsc-embedding/growable-memory"];
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export const jscEmbeddingArchives = ["build/jsc/lib/libJavaScriptCore.a", "build/jsc/lib/libWTF.a", "build/jsc/lib/libbmalloc.a", "icu/prefix/lib/libicuuc.a", "icu/prefix/lib/libicui18n.a", "icu/prefix/lib/libicudata.a", "shim/libwasi-compat.a"];

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
    archives: jscEmbeddingArchives
      .map(path => ({ path, sha256: hash(readFileSync(join(build, path))) })),
  };
}

function embeddingProgram(bytes: ProgramFiles<Uint8Array>) {
  if (bytes.kind !== "jsc" || programKind(new WebAssembly.Module(Uint8Array.from(bytes.core))) !== "jsc") throw new Error("JSC embedding requires the declared JSC pair");
  verifyProgramSide("jsc", new WebAssembly.Module(Uint8Array.from(bytes.side)));
  return { kind: "jsc", core: artifactIdentity(bytes.core), side: artifactIdentity(bytes.side) };
}

export function verifyEmbeddingReceipt(value: unknown, expected: ReturnType<typeof inputs>, bytes: ProgramFiles<Uint8Array>): void {
  const receipt = { ...expected, program: embeddingProgram(bytes) };
  if (JSON.stringify(value) !== JSON.stringify(receipt)) throw new Error("JSC embedding source/prebuild/artifact receipt mismatch");
}

// Fixtures that need a live host handshake, not a final stdout snapshot, own their runner.
export function handshakeCommands(artifact: string): string[][] {
  return [["node", "--no-warnings", join(root, "tests/test-stdout-busy-loop.ts"), "--engine", "jsc", "--wasm", artifact]];
}

export function stackFixture() {
  const manifest = "native-stack-getter-headroom.json";
  const check = parseCheck(JSON.parse(readFileSync(join(root, "checks", manifest), "utf8")), manifest);
  if (check.owner !== "native") throw new Error("JSC stack fixture needs its native check owner");
  return { path: check.path, hostOptions: ["--stack-mb", "1", "--env", "BUN_WASM_STACK_KIB=800", "--env", "BUNWASM_STACK_EXPECT_CAUGHT=1"] };
}

/**
 * Getter semantics at the smallest browser budget on a small real host stack, with the reduced
 * Ajv names walk far deeper than that budget ever allowed while getters reentered the interpreter
 * (16 levels at 192 KiB; Angular's registry needs about 64). docs/bun-patches/jsc-getter-dispatch.md.
 */
export function getterDispatchFixture() {
  const manifest = "native-getter-dispatch.json";
  const check = parseCheck(JSON.parse(readFileSync(join(root, "checks", manifest), "utf8")), manifest);
  if (check.owner !== "native") throw new Error("JSC getter dispatch fixture needs its native check owner");
  return { path: check.path, hostOptions: ["--stack-mb", "1", "--env", "BUN_WASM_STACK_KIB=192", "--env", "GETTER_DISPATCH_AJV_DEPTH=2000", "--env", "GETTER_DISPATCH_WIDE_LOCALS=33000"] };
}

/** Forwarded Proxy reads keep their semantics and overflow as a catchable error on a small host stack. */
export function proxyGetForwardingFixture() {
  const manifest = "native-proxy-get-forwarding.json";
  const check = parseCheck(JSON.parse(readFileSync(join(root, "checks", manifest), "utf8")), manifest);
  if (check.owner !== "native") throw new Error("JSC Proxy forwarding fixture needs its native check owner");
  return { path: check.path, hostOptions: ["--stack-mb", "1", "--env", "BUN_WASM_STACK_KIB=192"] };
}

/**
 * Bound-function call semantics at the smallest browser budget on a small real host stack, with
 * Babel's printer cycle (a bound callback per level) far deeper than the 30 levels it reached while
 * bound calls reentered the interpreter, and a caller that needs the widest operand form.
 * docs/bun-patches/jsc-bound-call-dispatch.md.
 */
export function boundCallDispatchFixture() {
  const manifest = "native-bound-call-dispatch.json";
  const check = parseCheck(JSON.parse(readFileSync(join(root, "checks", manifest), "utf8")), manifest);
  if (check.owner !== "native") throw new Error("JSC bound call fixture needs its native check owner");
  return { path: check.path, hostOptions: ["--stack-mb", "1", "--env", "BUN_WASM_STACK_KIB=192", "--env", "BOUND_CALL_BABEL_DEPTH=2000", "--env", "BOUND_CALL_WIDE_LOCALS=33000"] };
}

/** The parser chain fixture on this pair: JSC must refuse its deeper chain with a catchable RangeError. */
export function parserChainFixture() {
  const manifest = "native-parser-chain-stack.json";
  const check = parseCheck(JSON.parse(readFileSync(join(root, "checks", manifest), "utf8")), manifest);
  if (check.owner !== "native") throw new Error("JSC parser chain fixture needs its native check owner");
  return { path: check.path, hostOptions: ["--env", "BUNWASM_STACK_EXPECT_CAUGHT=1"] };
}

/**
 * Deep chains through all nine assignment forms on a small real host stack, at the smallest browser
 * budget and at V8's: the code generator must refuse each with a RangeError that runs no setter
 * (docs/bun-patches/jsc-assignment-chains.md).
 */
export function assignmentChainFixtures() {
  const manifest = "native-assignment-chain-depth.json";
  const check = parseCheck(JSON.parse(readFileSync(join(root, "checks", manifest), "utf8")), manifest);
  if (check.owner !== "native") throw new Error("JSC assignment chain fixture needs its native check owner");
  return ["192", "800"].map(budget => ({ path: check.path, hostOptions: ["--stack-mb", "1", "--env", `BUN_WASM_STACK_KIB=${budget}`, "--env", "BUNWASM_STACK_EXPECT_CAUGHT=1"] }));
}

/**
 * JSC's statement record limit, exactly: each nest shape is accepted at its last counted record and
 * refused at the next with the parser's RangeError before running, at the smallest browser budget
 * (the records use no stack). And deep `await using` nests past the limit are refused before
 * acquiring anything (docs/bun-patches/jsc-statement-records.md).
 */
export function statementRecordFixtures() {
  return ["native-statement-record-cap.json", "native-statement-records-async-using.json"].map((manifest) => {
    const check = parseCheck(JSON.parse(readFileSync(join(root, "checks", manifest), "utf8")), manifest);
    if (check.owner !== "native") throw new Error("JSC statement record fixtures need their native check owner");
    return { path: check.path, hostOptions: ["--env", "BUN_WASM_STACK_KIB=192", "--env", "BUNWASM_STATEMENT_RECORDS_EXACT=1"] };
  });
}

/**
 * The array literal fixture: the core refuses the literal's 80,016-byte constant buffer during
 * bytecode generation, then the array's own storage on the first call (docs/bun-patches/jsc-array-literal-allocation.md).
 */
export function arrayLiteralFixture() {
  return { path: "tests/jsc-embedding/array-literal-allocation", hostOptions: ["--refuse-engine-allocation", "80000-80511:2"] };
}

function testFixtures(artifact: string): void {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-jsc-embedding-"));
  try {
    for (const fixture of fixtures) runFixture(artifact, fixture, scratch);
    const literal = arrayLiteralFixture();
    runFixture(artifact, literal.path, scratch, literal.hostOptions);
    const stack = stackFixture();
    runFixture(artifact, stack.path, scratch, stack.hostOptions);
    const forwarding = proxyGetForwardingFixture();
    runFixture(artifact, forwarding.path, scratch, forwarding.hostOptions);
    const getters = getterDispatchFixture();
    runFixture(artifact, getters.path, scratch, getters.hostOptions);
    const bound = boundCallDispatchFixture();
    runFixture(artifact, bound.path, scratch, bound.hostOptions);
    const chain = parserChainFixture();
    runFixture(artifact, chain.path, scratch, chain.hostOptions);
    for (const assignments of assignmentChainFixtures()) runFixture(artifact, assignments.path, scratch, assignments.hostOptions);
    for (const records of statementRecordFixtures()) runFixture(artifact, records.path, scratch, records.hostOptions);
    // The parser reserve at every host budget, its rejected forms and each shipped value (docs/stack-limits.md).
    for (const record of parserReserveControls(nodeHost(artifact))) console.log(JSON.stringify(record));
    console.log("PASS JSC parser reserve tuples");
    for (const command of handshakeCommands(artifact)) runHandshake(command, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runFixture(artifact: string, fixture: string, scratch: string, hostOptions: readonly string[] = []): void {
  const source = join(root, fixture);
  const work = join(scratch, fixture);
  cpSync(source, work, { recursive: true });
  const run = spawnSync("node", ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--wasm", artifact].concat(hostOptions, [
    "--engine", `jsc=${artifact}`, "--dir", `${work}::/`, "--env", "PATH=/opt/bun/jsc/bin:/bin:/usr/bin", "--env", "PWD=/", "--env", "HOME=/", "--env", "BUNWASM_TEST=1", "--", "run", "/index.ts"]),
  { cwd: work, encoding: "utf8", timeout: 60_000, env: { ...process.env, BUN_WASM_SCRATCH_ROOT: scratch, TMPDIR: scratch, AGENT: "0", CLAUDECODE: "" } });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.error) throw run.error;
  if (run.status !== 0 || run.stdout !== readFileSync(join(source, "expected.txt"), "utf8")) {
    throw new Error(`JSC fixture ${fixture} failed, exit ${run.status}, signal ${run.signal}`);
  }
  console.log(`PASS JSC ${fixture}`);
}

function runHandshake([executable, ...args]: string[], scratch: string): void {
  const run = spawnSync(executable!, args, { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, BUN_WASM_SCRATCH_ROOT: scratch } });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`JSC handshake ${args[1]} failed, exit ${run.status}, signal ${run.signal}`);
}

if (import.meta.main) {
  const [command, artifactName, snapshot] = process.argv.slice(2);
  // Development only: the gate's fixture runs on any pair. It checks no receipt, so it says
  // nothing about which source or prebuild the pair came from.
  if (command === "fixtures" && artifactName) {
    testFixtures(resolve(artifactName));
    process.exit(0);
  }
  const current = inputs();
  if (command === "inputs") {
    console.log(JSON.stringify(current));
  } else if (command === "write" && artifactName && snapshot) {
    if (JSON.stringify(current) !== snapshot) throw new Error("JSC embedding inputs changed during build");
    const core = await Bun.file(artifactName).bytes();
    const side = await Bun.file(join(dirname(artifactName), "jsc-engine.wasm")).bytes();
    await Bun.write(`${artifactName}.embedding.json`, JSON.stringify({ ...current, program: embeddingProgram({ kind: "jsc", core, side }) }));
  } else if (command === "test" && artifactName) {
    const artifact = resolve(artifactName);
    const bytes = await Bun.file(artifact).bytes();
    const side = await Bun.file(join(dirname(artifact), "jsc-engine.wasm")).bytes();
    verifyEmbeddingReceipt(await Bun.file(`${artifact}.embedding.json`).json(), current, { kind: "jsc", core: bytes, side });
    const receipt: unknown = await Bun.file(`${artifact}.build.json`).json();
    verifyGuestBuildReceipt(bytes, receipt);
    await verifyGuestCompanions(receipt, dirname(artifact));
    console.log(`JSC source ${current.sourceHead}; guest sha256 ${hash(bytes)}`);
    testFixtures(artifact);
  } else {
    throw new Error("Usage: jsc-embedding.ts inputs | write ARTIFACT INPUTS_JSON | test ARTIFACT | fixtures ARTIFACT");
  }
}
