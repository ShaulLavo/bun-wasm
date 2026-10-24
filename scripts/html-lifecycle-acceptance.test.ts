import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acceptanceCommands, admit, hash, trackedNativeInputs, parseQualification, upstreamPassed, upstreamTest, type Engine, type Qualification } from "./html-lifecycle-acceptance";

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root].concat(args), { stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function repository(root: string) {
  mkdirSync(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Harness unit test"]);
  git(root, ["config", "user.email", "unit@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
}
function commit(root: string) {
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "test input"]);
  return { head: git(root, ["rev-parse", "HEAD"]), tree: git(root, ["rev-parse", "HEAD^{tree}"]) };
}
function put(path: string, bytes: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { path, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
}
function setup(scratch: string, engine: Engine) {
  const root = join(scratch, "candidate"), upstream = join(scratch, "upstream");
  repository(root);
  repository(upstream);
  const leak = put(join(upstream, "test", upstreamTest), "Unchanged upstream fixture unit input\n");
  const vendor = commit(upstream);
  put(join(root, "scripts/sync-bun.sh"), `BUN_COMMIT=${vendor.head}\n`);
  const source = put(join(root, "crates/bunwasm-runtime/src/js/html_rewriter.ts"), "selected HTML source\n");
  const tracked = Object.entries(trackedNativeInputs).map(([role, relative]) => ({ ...put(join(root, relative), `tracked input ${role}\n`), role }));
  const identity = commit(root);
  const emitted = put(join(scratch, "out/runtime-js/html_rewriter.js"), "selected emitted HTML payload\n");
  const polyfills = put(join(scratch, "out/polyfills.rs"), `("html_rewriter", include_str!(${JSON.stringify(emitted.path)}))\n`);
  const roles = ["toolchain", "sysroot", "crypto-native", "crypto-wasi", "engine", "cargo-selection", "linkage"];
  if (engine === "browser") roles.push("browser-host", "waffle");
  const inputs = roles.map(role => ({ ...put(join(scratch, `${role}.input`), `${role} native input\n`), role })).concat(tracked);
  if (engine === "jsc") {
    const directory = join(scratch, "jsc");
    const stamp = put(join(directory, "build/jsc/.bunwasm-inputs"), "authoritative stamp\n");
    const check = put(join(scratch, "jsc.check"), JSON.stringify({ directory, source: identity, helper: "jsc/common.sh:check_jsc_inputs_stamp", exit: 0, stampSha256: stamp.sha256 }));
    inputs.push({ ...stamp, role: "jsc-stamp" }, { ...check, role: "jsc-authoritative-check" });
  }
  const features = [engine === "browser" ? "engine-host" : `engine-${engine}`, "bun-transpiler", "bun-build"];
  const rawGuest = put(join(scratch, "raw.wasm"), `raw unit bytes\n${readFileSync(emitted.path)}`);
  const executedGuest = put(join(scratch, "executed.wasm"), `optimized unit bytes\n${readFileSync(emitted.path)}`);
  const sidecar = put(join(scratch, "guest.build.json"), JSON.stringify({ bunHead: vendor.head, bunTree: vendor.tree,
    sysrootReceiptSha256: hash("sysroot native input\n"), artifactSha256: executedGuest.sha256, artifactBytes: executedGuest.bytes }));
  inputs.push({ ...sidecar, role: "guest-build-receipt" });
  const nativeInputs = put(join(scratch, "native-inputs.json"), JSON.stringify(inputs));
  const launcher = put(join(scratch, "launcher"), "non-executable unit bytes, never launched\n");
  const evidence = { source: identity, engine, features, command: ["recorded-build-command"], cargoOutDir: dirname(polyfills.path), jsOverrideDir: null,
    rawGuestSha256: rawGuest.sha256, executedGuestSha256: executedGuest.sha256, launcherSha256: launcher.sha256,
    htmlSourceSha256: source.sha256, htmlEmittedSha256: emitted.sha256, polyfillsSha256: polyfills.sha256, nativeInputsSha256: nativeInputs.sha256 };
  const buildEvidence = put(join(scratch, "build-evidence.json"), JSON.stringify(evidence));
  const qualification: Qualification = { schema: 1, source: identity, engine, features, upstream: { ...vendor, root: upstream, pin: vendor.head, leakTestSha256: leak.sha256 },
    html: { source, emitted, polyfills }, nativeInputs, buildEvidence, rawGuest, executedGuest, launcher };
  const receipt = join(scratch, "qualification.json");
  const save = () => put(receipt, JSON.stringify(qualification));
  save();
  return { root, qualification, receipt, save, evidence };
}
function withInputs(check: (state: ReturnType<typeof setup>) => void, engine: Engine = "quickjs") {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-html-admission-unit-"));
  try { check(setup(scratch, engine)); }
  finally { rmSync(scratch, { recursive: true }); }
}
function admitCurrent(state: ReturnType<typeof setup>, selected: Engine = state.qualification.engine) {
  return admit(state.root, state.receipt, hash(readFileSync(state.receipt)), selected);
}

for (const engine of ["quickjs", "jsc", "browser"] satisfies Engine[]) {
  test(`admit externally pinned ${engine} identity without launching a guest`, () => {
    withInputs(state => expect(admitCurrent(state)).toEqual(state.qualification), engine);
  });
}

test("qualification pin is independent of receipt claims", () => {
  withInputs(state => expect(() => admit(state.root, state.receipt, "0".repeat(64), "quickjs")).toThrow("Qualification digest mismatch"));
});

test("reject historical source head/tree and dirty candidate", () => {
  withInputs(state => {
    state.qualification.source.head = "a".repeat(40);
    state.save();
    expect(() => admitCurrent(state)).toThrow("Source head/tree mismatch");
  });
  withInputs(state => {
    writeFileSync(join(state.root, "unexpected.ts"), "uncommitted");
    expect(() => admitCurrent(state)).toThrow("Source is not clean");
  });
});

test("reject engine and feature mismatches", () => {
  withInputs(state => {
    expect(() => admitCurrent(state, "browser")).toThrow("Engine mismatch");
    state.qualification.features = ["engine-jsc"];
    state.save();
    expect(() => admitCurrent(state)).toThrow("Engine feature mismatch");
  });
});

test("reject edited upstream source and changed upstream test identity", () => {
  withInputs(state => {
    writeFileSync(join(state.qualification.upstream.root, "test", upstreamTest), "changed");
    expect(() => admitCurrent(state)).toThrow("Source is not clean");
  });
  withInputs(state => {
    state.qualification.upstream.leakTestSha256 = "0".repeat(64);
    state.save();
    expect(() => admitCurrent(state)).toThrow("Upstream test identity mismatch");
  });
});

for (const input of ["rawGuest", "executedGuest", "launcher", "nativeInputs", "buildEvidence"] satisfies (keyof Pick<Qualification, "rawGuest" | "executedGuest" | "launcher" | "nativeInputs" | "buildEvidence">)[]) {
  test(`reject modified ${input} bytes`, () => {
    withInputs(state => {
      writeFileSync(state.qualification[input].path, "modified");
      expect(() => admitCurrent(state)).toThrow("File identity mismatch");
    });
  });
}

test("reject missing actual payload even if guest hash is updated", () => {
  withInputs(state => {
    state.qualification.executedGuest = put(state.qualification.executedGuest.path, "historical guest with no current payload");
    state.evidence.executedGuestSha256 = state.qualification.executedGuest.sha256;
    const sidecar = put(join(dirname(state.receipt), "guest.build.json"), JSON.stringify({ bunHead: state.qualification.upstream.head, bunTree: state.qualification.upstream.tree,
      sysrootReceiptSha256: hash("sysroot native input\n"), artifactSha256: state.qualification.executedGuest.sha256, artifactBytes: state.qualification.executedGuest.bytes }));
    const manifest: unknown = JSON.parse(readFileSync(state.qualification.nativeInputs.path, "utf8"));
    if (!Array.isArray(manifest)) throw new Error("unit manifest must be array");
    const inputs = manifest.filter(value => !value || typeof value !== "object" || !("role" in value) || value.role !== "guest-build-receipt");
    state.qualification.nativeInputs = put(state.qualification.nativeInputs.path, JSON.stringify(inputs.concat([{ ...sidecar, role: "guest-build-receipt" }])));
    state.evidence.nativeInputsSha256 = state.qualification.nativeInputs.sha256;
    state.qualification.buildEvidence = put(state.qualification.buildEvidence.path, JSON.stringify(state.evidence));
    state.save();
    expect(() => admitCurrent(state)).toThrow("Selected HTML payload absent");
  });
});

test("reject Cargo-selected payload path and selected override source mismatch", () => {
  withInputs(state => {
    state.qualification.html.polyfills = put(state.qualification.html.polyfills.path, '("html_rewriter", include_str!("wrong.js"))');
    state.save();
    expect(() => admitCurrent(state)).toThrow("Cargo polyfill selection mismatch");
  });
  withInputs(state => {
    state.qualification.html.source = put(join(dirname(state.receipt), "override.ts"), "wrong source");
    state.save();
    expect(() => admitCurrent(state)).toThrow("Selected HTML source differs");
  });
});

test("reject native input mutation and missing closure roles", () => {
  withInputs(state => {
    writeFileSync(join(dirname(state.receipt), "sysroot.input"), "changed native sysroot");
    expect(() => admitCurrent(state)).toThrow("File identity mismatch");
  });
  withInputs(state => {
    state.qualification.nativeInputs = put(state.qualification.nativeInputs.path, "[]");
    state.save();
    expect(() => admitCurrent(state)).toThrow("Missing native-input manifest");
  });
});

test("reject mismatched build linkage instead of trusting matching HTML alone", () => {
  withInputs(state => {
    state.evidence.nativeInputsSha256 = "0".repeat(64);
    state.qualification.buildEvidence = put(state.qualification.buildEvidence.path, JSON.stringify(state.evidence));
    state.save();
    expect(() => admitCurrent(state)).toThrow("Build evidence nativeInputs mismatch");
  });
});

test("require JSC authoritative stamp evidence and browser host/dependency closure", () => {
  withInputs(state => {
    state.qualification.engine = "jsc";
    state.qualification.features = ["engine-jsc"];
    state.save();
    expect(() => admitCurrent(state)).toThrow("Missing native-input role: jsc-stamp");
  });
  withInputs(state => {
    state.qualification.engine = "browser";
    state.qualification.features = ["engine-host"];
    state.save();
    expect(() => admitCurrent(state)).toThrow("Missing native-input role: browser-host");
  });
});

test("invalid schemas cannot masquerade as qualified input", () => {
  for (const value of [null, {}, { schema: 1 }, []]) expect(() => parseQualification(value)).toThrow();
});

test("runner commands preserve explicit artifacts, full fixtures and original upstream policy", () => {
  withInputs(state => {
    const commands = acceptanceCommands(state.root, state.qualification, "/owned/report");
    expect(commands.fixtures).toContain("--no-build");
    expect(commands.fixtures).toContain(state.qualification.executedGuest.path);
    expect(commands.fixtures.slice(-5)).toEqual(["html-handler-lifetime", "html-handler-contracts", "html-intrinsic-storage", "html-rewriter", "html-rewriter-review"]);
    expect(commands.upstream).toContain(state.qualification.launcher.path);
    expect(commands.upstream.slice(-10)).toEqual(["1", "--timeout", "15", "--network", "loopback", "--output", "/owned/report/upstream.json", "--log-dir", "/owned/report/upstream-cases", upstreamTest]);
    expect(JSON.stringify(commands)).not.toMatch(/build\.sh|cargo|install|--update|--limit|--test-name-pattern/);
  });
});

test("partial upstream results and skips never become full green", () => {
  const result = { file: upstreamTest, exit: 0, complete: true, fully_passing: true, timed_out: false, counts: { pass: 10, fail: 0, errors: 0, skip: 0, todo: 0 } };
  expect(upstreamPassed({ selected_files: 1, results: [result] })).toBe(true);
  for (const key of ["fail", "errors", "skip", "todo"]) {
    const counts = { ...result.counts, [key]: 1 };
    expect(upstreamPassed({ selected_files: 1, results: [{ ...result, counts }] })).toBe(false);
  }
  expect(upstreamPassed({ selected_files: 1, results: [{ ...result, complete: false }] })).toBe(false);
  expect(upstreamPassed({ selected_files: 1, results: [{ ...result, timed_out: true }] })).toBe(false);
  expect(upstreamPassed({ selected_files: 0, results: [] })).toBe(false);
});

test("native parser/testing inputs must match the frozen checkout, not only payload bytes", () => {
  withInputs(state => {
    const values: unknown = JSON.parse(readFileSync(state.qualification.nativeInputs.path, "utf8"));
    expect(Array.isArray(values)).toBe(true);
    if (!Array.isArray(values)) throw new Error("unit fixture must be array");
    state.qualification.nativeInputs = put(state.qualification.nativeInputs.path, JSON.stringify(values.filter(value => !value || typeof value !== "object" || !("role" in value) || value.role !== "html-parser")));
    state.save();
    expect(() => admitCurrent(state)).toThrow("Tracked native input mismatch: html-parser");
  });
});

test("matching payload does not excuse a wrong guest build sidecar", () => {
  withInputs(state => {
    writeFileSync(join(dirname(state.receipt), "guest.build.json"), "wrong sidecar");
    expect(() => admitCurrent(state)).toThrow("File identity mismatch");
  });
});

function selectedTestPaths(script: string) {
  const root = resolve(import.meta.dir, "..");
  const source = readFileSync(join(root, script), "utf8");
  return Array.from(source.matchAll(/^[ \t]*bun test (.+)$/gm)).flatMap(command => {
    const directory = Array.from(source.slice(0, command.index).matchAll(/^[ \t]*cd "\$root([^"]*)"$/gm)).at(-1)?.[1] ?? "";
    const cwd = resolve(root, `.${directory}`);
    return command[1].split(/\s+/).map(selector => {
      if (!/^(?:"\$root\/scripts\/[^"]+"|\.\.\/scripts\/\S+)$/.test(selector)) throw new Error(`Unsupported literal test selector: ${selector}`);
      return realpathSync(resolve(cwd, selector.replaceAll('"', "").replace("$root", root)));
    });
  });
}

test("HTML lifecycle acceptance has one blocking owner in the web-host selectors", () => {
  const target = realpathSync(import.meta.filename);
  const runtime = selectedTestPaths("scripts/check-runtime.sh");
  const web = selectedTestPaths("scripts/test-web-host.sh");
  expect(runtime.length).toBeGreaterThan(0);
  expect(web.length).toBeGreaterThan(0);
  expect(runtime.filter(path => path === target)).toEqual([]);
  expect(web.filter(path => path === target)).toEqual([target]);
});
