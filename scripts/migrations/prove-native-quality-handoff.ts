import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = ".github/workflows/ci.yml";
const controller = "scripts/ci-native-handoff.ts";
const originals = new Map([workflow, controller].map(path => [path, readFileSync(path, "utf8")]));
const mutations: [string, string, string, string][] = [
  ["needs-induced skip", workflow, "if: ${{ !cancelled() && needs.quality.result == 'success' && needs.quality.outputs.rust == 'true' }}", "if: needs.quality.outputs.rust == 'true'"],
  ["failed quality accepted", workflow, ' || "$NATIVE_QUALITY_RESULT" != success', ""],
  ["prebuild selected by JSC only", workflow, "    needs: quality\n    if: needs.quality.outputs.rust == 'true'\n    runs-on: ubuntu-latest\n    # A cold", "    needs: quality\n    if: needs.quality.outputs.jsc == 'true'\n    runs-on: ubuntu-latest\n    # A cold"],
  ["native cap raised", workflow, "    timeout-minutes: 60\n", "    timeout-minutes: 90\n"],
  ["quality cap raised", workflow, "    timeout-minutes: 45\n    env:", "    timeout-minutes: 60\n    env:"],
  ["prebuild digest unchecked", workflow, '          echo "$JSC_PREBUILD_MANIFEST_SHA256  $bundle/manifest" | sha256sum --check --strict\n', ""],
  ["prebuild identity unchecked", workflow, '          [[ "$(head -n 4 "$bundle/manifest")" == "$expected" ]]\n', ""],
  ["prebuild archive unchecked", workflow, '          (cd "$bundle" && tail -n +5 manifest | sha256sum --check --strict)\n', ""],
  ["prebuild overlay", workflow, '          [[ ! -e "$JSC_BUILD_DIR" && ! -e "$BUN_WASM_SYSROOT" ]]\n', ""],
  ["prebuild stamp unchecked", workflow, "          source jsc/common.sh\n          check_jsc_inputs_stamp\n", ""],
  ["prebuild group unowned", workflow, "          set -m\n          (\n            set +m\n", "          (\n"],
  ["tracked dependency fixtures omitted", controller, 'path.split("/").includes("node_modules") && !tracked.has(path)', 'path.split("/").includes("node_modules")'],
  ["untracked installs included", controller, 'path.split("/").includes("node_modules") && !tracked.has(path)', "false"],
  ["native manifest unchecked", controller, 'await hash(join(bundle, "manifest.json")) !== process.env.NATIVE_QUALITY_MANIFEST_SHA256', "false"],
  ["native source/tool identity unchecked", controller, 'manifest.schema !== 1 || JSON.stringify(manifest.identity) !== JSON.stringify(state.identity)', "false"],
  ["native archive whitelist unchecked", controller, 'JSON.stringify(Object.keys(archives)) !== JSON.stringify(archiveNames)', "false"],
  ["native archive unchecked", controller, 'archives[name] !== await hash(join(bundle, name))', "false"],
  ["native overlay", controller, "  preflightDestinations(state);", ""],
  ["consumer attempt substituted", controller, 'const attempt = required("NATIVE_QUALITY_PRODUCER_ATTEMPT");', 'const attempt = required("GITHUB_RUN_ATTEMPT");'],
  ["source verifier removed", controller, '  execFileSync("bash", [join(state.workspace, "scripts/sync-bun.sh"), "--check"], { stdio: "inherit" });', ""],
  ["Git identity unchecked", controller, 'git(bun, "rev-parse", "HEAD") !== manifest.bun.head || git(bun, "rev-parse", "HEAD^{tree}") !== manifest.bun.tree', "false"],
  ["credential config included", controller, '/^(?:HEAD|index|shallow|packed-refs)$/.test(metadata.rest)', '/^(?:HEAD|index|shallow|packed-refs|config)$/.test(metadata.rest)'],
  ["mtimes discarded", controller, "tar --posix --no-recursion", "tar --posix --mtime=@0 --no-recursion"],
  ["symlinks dereferenced", controller, "tar --posix --no-recursion", "tar --posix --dereference --no-recursion"],
  ["duplicate common core", workflow, "          CARGO_BUILD_JOBS=2 bash scripts/build-bun-core.sh", "          CARGO_BUILD_JOBS=2 bash scripts/build-bun-core.sh\n          CARGO_BUILD_JOBS=2 bash scripts/build-bun-core.sh"],
  ["PR heavy save", workflow, "github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.native-cargo-cache.outputs.cache-hit != 'true'", "steps.native-cargo-cache.outputs.cache-hit != 'true'"],
];
const tests = ["scripts/ci-native-handoff.test.ts", "scripts/ci-jsc-prebuild.test.ts", "scripts/ci-cache-inputs.test.ts", "scripts/ci-cache-policy.test.ts", "scripts/ci-quality.test.ts", "scripts/test-web-guests.test.ts"];
function probe(): number {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-native-mutations-"));
  try {
    const result = spawnSync("bun", ["test"].concat(tests), { encoding: "utf8", timeout: 30000, env: { ...process.env, TMPDIR: scratch } });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (probe() !== 0) throw new Error("Mutation baseline is not green");
try {
  for (const [label, path, before, after] of mutations) {
    const original = originals.get(path);
    if (!original?.includes(before)) throw new Error(`Missing mutation anchor: ${label}`);
    writeFileSync(path, original.replaceAll(before, after));
    const status = probe();
    writeFileSync(path, original);
    if (status === 0) throw new Error(`Mutation survived: ${label}`);
    console.log(`killed: ${label}`);
  }
} finally {
  for (const [path, original] of originals) writeFileSync(path, original);
}
console.log(`${mutations.length}/${mutations.length} policy mutations rejected`);
