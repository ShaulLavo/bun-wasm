import { parseCheck } from "./test-checks";
import { coverageOwners, coverageBatches, coverageWrappers, fullBrowserGuestSelection, ownerEngines, unionBrowserGuestSelections,
  type BrowserGuestSelection, type CoverageOwner, type CoverageEngine } from "./browser-guest-catalogue";

// Exact serving/startup imports, not all Web source. Template contents remain Storage-owned.
const commonInputs = [
  ".github/workflows/ci.yml",
  ".github/actions/native-setup/action.yml",
  ".github/actions/native-seed/action.yml",
  ".github/actions/native-production/action.yml",
  ".github/actions/jsc-setup/action.yml",
  ".github/actions/jsc-prebuild/action.yml",
  "scripts/ci-main-coverage.ts",
  "scripts/ci-browser-coverage.ts",
  "scripts/ci-changes.ts",
  "scripts/ci-check-inputs.ts",
  "scripts/ci-binaryen.ts",
  "scripts/ci-build-tools.ts",
  "scripts/test-checks.ts",
  "bun.lock",
  "package.json",
  "sandbox/build.ts",
  "sandbox/bun.lock",
  "sandbox/package.json",
  "scripts/base-program-build.ts",
  "scripts/bash-web-guests.ts", "scripts/bash-web-release-inputs.json",
  "scripts/browser-build.ts",
  "scripts/browser-guest-catalogue.ts",
  "scripts/browser-guest-coverage.ts",
  "scripts/browser-guest-regression.ts",
  "scripts/browser-guest-selection.ts",
  "scripts/browser-guest-wrapper.ts",
  "scripts/browser-guest-site.ts",
  "scripts/waffle-release-inputs.ts",
  "scripts/waffle-release-inputs.json",
  "scripts/linux-subreaper.mts",
  "scripts/process-owner.mts",
  "scripts/run-with-timeout.mts",
  "src/assets.ts",
  "src/engine-kind.ts",
  "src/executable-paths.ts",
  "src/guest-asset.generated.ts",
  "src/package-continuation-binding.ts",
  "src/package-continuation-plan.ts",
  "src/process-runtime.ts",
  "src/program-memory.ts",
  "src/quickjs-program.ts",
  "web/_headers",
  "web/build.ts",
  "web/bun.lock",
  "web/index.html",
  "web/package.json",
  "web/preview-build.ts",
  "web/src/buffer-transfer.ts",
  "web/src/bun-executor.ts",
  "web/src/bun-launcher.ts",
  "web/src/compile-observer.ts",
  "web/src/content-modules.ts",
  "web/src/crypto-host.js",
  "web/src/crypto-inputs.js",
  "web/src/default-signal.ts",
  "web/src/early-instance.ts",
  "web/src/engine-host.js",
  "web/src/engine-loader.ts",
  "web/src/engine-stack-budget.ts",
  "web/src/fs-worker.ts",
  "web/src/fs.ts",
  "web/src/host-memory-policy.ts",
  "web/src/jsc-allocation-boundary.ts",
  "web/src/launch-failure.ts",
  "web/src/memory-channel.ts",
  "web/src/memory-telemetry.ts",
  "web/src/module-records.ts",
  "web/src/native-direct-stream.ts",
  "web/src/native-readable-iterator.ts",
  "web/src/native-stream-state.ts",
  "web/src/native-wasm-lifetime.ts",
  "web/src/nested/binary.ts",
  "web/src/nested/function-type.ts",
  "web/src/nested/host.ts",
  "web/src/nested/module-info.ts",
  "web/src/nested/publication.ts",
  "web/src/nested/wire.ts",
  "web/src/net/helper.ts",
  "web/src/net/host.ts",
  "web/src/net/install-cache.ts",
  "web/src/net/lookup.ts",
  "web/src/net/package-fetch.ts",
  "web/src/net/protocol.ts",
  "web/src/net/relay.ts",
  "web/src/net/ring.ts",
  "web/src/net/trampoline.ts",
  "web/src/notification-worker.ts",
  "web/src/preview-owner-client.ts",
  "web/src/preview-owner-protocol.ts",
  "web/src/preview-protocol.ts",
  "web/src/preview.ts",
  "web/src/preview1-executor.ts",
  "web/src/preview1-worker.ts",
  "web/src/program-launcher.ts",
  "web/src/program-profile.ts",
  "web/src/promise-reactions.ts",
  "web/src/runner.ts",
  "web/src/script-evaluation.ts",
  "web/src/shared-objects/broker.ts",
  "web/src/shared-objects/host.ts",
  "web/src/shared-objects/lane-overflow.ts",
  "web/src/shared-objects/lane.ts",
  "web/src/shared-objects/mailbox.ts",
  "web/src/shared-objects/native.ts",
  "web/src/shared-objects/protocol.ts",
  "web/src/shared-objects/realm.ts",
  "web/src/shared-objects/runtime.ts",
  "web/src/shared-objects/service.ts",
  "web/src/startup-cache.ts",
  "web/src/startup.ts",
  "web/src/subprocess-broker.ts",
  "web/src/sw.ts",
  "web/src/tool-command.ts",
  "web/src/wasm-call-trap.ts",
  "web/src/worker-main.ts",
  "web/src/worker.ts"
];
const playgroundInputs = [
  "scripts/accept-encoding.ts",
  "web/navigation-server-log.ts",
  "web/preview-origin-host.ts",
  "web/scripts/preview-exchanges.ts",
  "web/scripts/preview-owner-host.ts",
  "web/scripts/preview-port-sockets.ts",
  "web/serve.ts",
  "web/src/browser-programs.ts",
  "web/src/bun-terminal.ts",
  "web/src/copy-button.tsx",
  "web/src/examples.ts",
  "web/src/hosted-previews.ts",
  "web/src/main.ts",
  "web/src/playground/app.tsx",
  "web/src/playground/editor-pane.tsx",
  "web/src/playground/editor.ts",
  "web/src/playground/playground.ts",
  "web/src/playground/preview-links.ts",
  "web/src/playground/program-profile.ts",
  "web/src/playground/terminal-pane.tsx",
  "web/src/shared-fs.ts",
  "web/src/terminal-copy.ts",
  "web/src/terminal-links.ts",
  "web/src/terminal-mount.ts",
  "web/src/viewport.ts",
  "web/src/style.css"
];
const ownerInputs = {
  "installer-links": [
    "tests/install/registry.mjs",
    "web/tests/browser-installer-links.ts",
    "web/tests/browser-type.ts",
    "web/tests/foreground.ts",
    "web/tests/navigate-test-page.ts",
    "web/tests/playground-cleanup.ts",
    "web/tests/playground.mjs"
  ],
  "subprocess": [
    "tests/fixtures/lint-fmt-config/expected.txt",
    "tests/fixtures/lint-fmt-config/index.ts",
    "tests/fixtures/pipe-closed-child/index.ts",
    "tests/fixtures/pipe-stdin-race/index.ts",
    "tests/fixtures/pipe-write-order/child.ts",
    "tests/fixtures/pipe-write-order/index.ts",
    "tests/fixtures/spawn-executable/child.ts",
    "tests/fixtures/spawn-executable/index.ts",
    "tests/fixtures/spawn-stdin/expected.txt",
    "tests/fixtures/spawn-stdin/index.ts",
    "tests/fixtures/worker-execution/expected.txt",
    "tests/fixtures/worker-execution/index.ts",
    "tests/fixtures/worker-execution/preload.cjs",
    "tests/fixtures/worker-execution/worker.ts",
    "tests/fixtures/worker-port-closure/expected.txt",
    "tests/fixtures/worker-port-closure/index.ts",
    "tests/fixtures/worker-review/cases.ts",
    "web/tests/browser-subprocess.ts",
    "web/tests/browser-type.ts",
    "web/tests/browser-workers.ts",
    "web/tests/foreground.ts",
    "web/tests/navigate-test-page.ts",
    "web/tests/playground-cleanup.ts",
    "web/tests/playground.mjs"
  ],
  "preview-websocket": [
    "web/src/preview-websocket-client.ts",
    "tests/fixtures/net-bun-response-async-cancel/expected.txt",
    "tests/fixtures/net-bun-response-async-cancel/index.ts",
    "tests/fixtures/net-bun-response-disconnect/expected.txt",
    "tests/fixtures/net-bun-response-disconnect/index.ts",
    "tests/fixtures/net-bun-response-early-disconnect/expected.txt",
    "tests/fixtures/net-bun-response-early-disconnect/index.ts",
    "tests/fixtures/net-bun-response-length/expected.txt",
    "tests/fixtures/net-bun-response-length/index.ts",
    "tests/fixtures/net-bun-response-stream/expected.txt",
    "tests/fixtures/net-bun-response-stream/index.ts",
    "tests/fixtures/net-bun-tcp/expected.txt",
    "tests/fixtures/net-bun-tcp/index.js",
    "tests/fixtures/net-fetch-abort-reasons/expected.txt",
    "tests/fixtures/net-fetch-abort-reasons/index.ts",
    "tests/fixtures/net-http-upgrade/expected.txt",
    "tests/fixtures/net-http-upgrade/index.js",
    "tests/fixtures/net-tcp-empty-fin/expected.txt",
    "tests/fixtures/net-tcp-empty-fin/index.ts",
    "tests/fixtures/net-tcp/expected.txt",
    "tests/fixtures/net-tcp/index.js",
    "tests/fixtures/net-ws-builtin/expected.txt",
    "tests/fixtures/net-ws-builtin/index.js",
    "web/tests/browser-net.mjs",
    "web/tests/fixture-output.ts",
    "web/tests/foreground.ts",
    "web/tests/navigate-test-page.ts"
  ],
  "engine-interruption": [
    "web/tests/browser-engine-interruption.ts",
    "web/tests/navigate-test-page.ts",
    "web/tests/engine-interruption-atomics.ts",
    "web/tests/engine-interruption-benchmark.ts",
    "web/tests/engine-interruption-cases.ts",
    "web/tests/engine-interruption-guests.ts",
    "web/tests/engine-interruption-main.ts",
    "web/tests/engine-interruption-page.ts",
    "web/tests/engine-interruption-preview1.ts",
    "web/tests/engine-interruption-probe.ts",
    "web/tests/engine-interruption-result.ts",
    "web/tests/engine-interruption-safari.ts",
    "web/tests/engine-interruption-scope.ts",
    "web/tests/engine-interruption-sleep.ts",
    "web/tests/engine-interruption-stop.ts",
    "web/tests/engine-interruption-transport.ts",
    "web/tests/engine-interruption-worker.ts",
    "web/tests/process-module-fixture.ts",
    "scripts/spidermonkey-side-core-receipt.ts",
    "scripts/spidermonkey-side-inputs.ts"
  ],
  "worker-modules": [
    "tests/fixtures/worker-review/cases.ts",
    "web/tests/browser-type.ts",
    "web/tests/browser-worker-modules.ts",
    "web/tests/foreground.ts",
    "web/tests/navigate-test-page.ts",
    "web/tests/playground-cleanup.ts",
    "web/tests/playground.mjs"
  ],
  "terminal-stdin": [
    "web/tests/browser-playground-stdin.ts",
    "web/tests/foreground.ts",
    "web/tests/navigate-test-page.ts",
    "web/tests/playground-cleanup.ts",
    "web/tests/playground-stdin.ts",
    "web/tests/playground.mjs"
  ],
  "tools-integrity": [
    "web/tests/browser-tools.ts",
    "web/tests/tools-lifecycle.ts",
    "web/tests/tools-route.ts",
    "web/tests/playground-navigation.ts",
    "web/tests/browser-type.ts",
    "web/tests/foreground.ts",
    "web/tests/navigate-test-page.ts",
    "web/tests/playground-cleanup.ts",
    "web/tests/playground.mjs"
  ]
} satisfies Record<CoverageOwner, readonly string[]>;

export function browserGuestOwnerInputs(owner: CoverageOwner): string[] {
  return commonInputs.concat(owner === "engine-interruption" ? [] : playgroundInputs, ownerInputs[owner],
    ["installer-links", "subprocess", "preview-websocket", "tools-integrity"].includes(owner) ? ["scripts/browser-existing-drivers.ts"] : []);
}
export function browserGuestManifest(owner: CoverageOwner) {
  return { owner: "browser-guest", path: `scripts/${coverageWrappers[owner]}-browser.test.ts`, batch: coverageBatches[owner], inputs: browserGuestOwnerInputs(owner) } as const;
}
export interface CoverageManifestSnapshot {
  readonly role: "base" | "head" | "merge-ancestor";
  readonly ref: string;
  // Verified regular-file blobs from this exact ref, before filtering or flattening inputs.
  readonly manifests: readonly { readonly file: string; readonly value: unknown }[];
}

const engineRoots: Record<CoverageEngine, readonly string[]> = {
  quickjs: ["crates/bunwasm-engine-quickjs/", "third_party/rquickjs-sys/"],
  jsc: ["crates/bunwasm-engine-jsc/", "crates/bunwasm-jsc/", "jsc/"],
  browser: ["crates/bunwasm-engine-host/", "crates/bunwasm-runtime/src/engine_host/"],
};
const engineFiles: Record<CoverageEngine, readonly string[]> = {
  quickjs: ["scripts/build.sh", "scripts/build-engine-quickjs.sh", "scripts/quickjs-core-exports.txt", "crates/bunwasm-runtime/src/engine_quickjs.rs"],
  jsc: ["scripts/build-bun-jsc.sh", "scripts/build-engine-jsc.sh", "scripts/build-jsc.sh", "crates/bunwasm-runtime/src/engine_jsc.rs"],
  browser: ["scripts/build-bun-browser.sh", "scripts/wasm-name-sections.ts", "crates/bunwasm-runtime/src/engine_host.rs"],
};
const commonProducerFiles = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "env.sh", "scripts/build-bun-core.sh", "scripts/build-wasi-sysroot.ts",
  ".github/actions/jsc-setup/action.yml", ".github/actions/jsc-prebuild/action.yml", "scripts/ci-binaryen.ts", "scripts/ci-build-tools.ts",
  "scripts/waffle-release-inputs.ts", "scripts/waffle-release-inputs.json",
  "scripts/guest-source-manifest.ts", "scripts/guest-build-receipt.ts", "scripts/guest-core-receipt.ts", "scripts/guest-engine-receipt.ts",
  "scripts/src/program-profile.ts", "scripts/sync-bun.sh", "scripts/sync-crypto.sh", "scripts/transpile-runtime.ts", "scripts/generate-bun-wrap.ts", "scripts/generate-direct-stream.ts", "scripts/generate-node-path.ts", "scripts/generate-dev-html-client.ts",
  "web/src/dev-html-client.ts", "scripts/build-bash-web-shell.sh"];
const commonProducerRoots = ["crates/", "patches/", "vendor/", "third_party/", ".cargo/"];
const spiderMonkeyRoots = ["spidermonkey/"];
const spiderMonkeyFiles = ["scripts/build-bun-spidermonkey.sh", "scripts/build-engine-spidermonkey.sh"];
function touches(path: string, roots: readonly string[], files: readonly string[] = []): boolean {
  return files.includes(path) || roots.some(root => path.startsWith(root));
}
function safePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Unsafe coverage input: ${path}`);
}
function snapshotInputs(snapshots: readonly CoverageManifestSnapshot[]): Map<CoverageOwner, string[]> {
  if (snapshots.length !== 3 || new Set(snapshots.map(item => item.role)).size !== 3) throw new Error("Coverage selection requires base, head and merge-ancestor snapshots");
  const inputs = new Map(coverageOwners.map(owner => [owner, browserGuestOwnerInputs(owner).concat([`checks/browser-guest-${coverageWrappers[owner]}.json`, browserGuestManifest(owner).path])]));
  for (const snapshot of snapshots) {
    if (!/^[a-f0-9]{40}$/.test(snapshot.ref) || !["base", "head", "merge-ancestor"].includes(snapshot.role)) throw new Error("Unverified coverage snapshot ref/role");
    addSnapshotInputs(inputs, snapshot);
  }
  return inputs;
}
function addSnapshotInputs(inputs: Map<CoverageOwner, string[]>, snapshot: CoverageManifestSnapshot): void {
  const seen = new Set<string>();
  const owners = new Set<CoverageOwner>();
  for (const { file, value } of snapshot.manifests) {
    if (!/^checks\/[a-z0-9-]+\.json$/.test(file) || seen.has(file)) throw new Error(`Unsafe/duplicate snapshot manifest: ${file}`);
    seen.add(file);
    const check = parseCheck(value, file.replace(/^checks\//, ""));
    const owner = coverageOwners.find(owner => file === `checks/browser-guest-${coverageWrappers[owner]}.json` || check.owner === "browser-guest" && check.batch === coverageBatches[owner]);
    if (!owner && check.owner === "browser-guest" && /^2[0-6]-/.test(check.batch)) throw new Error(`Unknown coverage batch: ${check.batch}`);
    if (!owner) continue;
    if (owners.has(owner)) throw new Error(`Duplicate snapshot coverage owner: ${owner}`);
    owners.add(owner);
    if (check.owner !== "browser-guest" || check.profile === "shared-group" || check.batch !== coverageBatches[owner]) throw new Error(`Inconsistent coverage manifest: ${file}`);
    inputs.set(owner, (inputs.get(owner) ?? []).concat([file, check.path], check.inputs));
  }
}

/** Parent supplies genuine verified Git snapshots, including removed blobs; no artifact probes. */
export function selectBrowserGuestCoverage(request: { readonly changedPaths: readonly string[]; readonly snapshots: readonly CoverageManifestSnapshot[]; readonly full: boolean }): BrowserGuestSelection {
  const inputs = snapshotInputs(request.snapshots);
  for (const path of request.changedPaths) safePath(path);
  if (request.full) return unionBrowserGuestSelections(fullBrowserGuestSelection);
  let selected: BrowserGuestSelection = [];
  for (const path of request.changedPaths) selected = unionBrowserGuestSelections(selected, selectPath(path, inputs));
  return selected;
}
function selectPath(path: string, inputs: Map<CoverageOwner, string[]>): BrowserGuestSelection {
  if (/^crates\/.+\.d\.ts$/.test(path)) return [];
  const specific = coverageEnginesForPath(path);
  if (specific.length) return coverageOwners.flatMap(owner => {
    const engines = ownerEngines(owner).filter(engine => specific.includes(engine));
    return engines.length ? [{ owner, engines }] : [];
  });
  if (touches(path, commonProducerRoots, commonProducerFiles)) return fullBrowserGuestSelection;
  if (path === "scripts/build-bun-tools.sh" || path === "scripts/optimize-tools.ts") return [{ owner: "tools-integrity", engines: ownerEngines("tools-integrity") }];
  // SpiderMonkey is outside the catalogue, but the interruption batch runs its bundled pair, so its
  // engine inputs select that batch (crates/ already selects every batch).
  if (touches(path, spiderMonkeyRoots, spiderMonkeyFiles) && !path.endsWith(".md")) return [{ owner: "engine-interruption", engines: ownerEngines("engine-interruption") }];
  return coverageOwners.filter(owner => inputs.get(owner)?.includes(path)).map(owner => ({ owner, engines: ownerEngines(owner) }));
}
const pairedSideFiles = ["allocator.rs", "client.rs", "driver.rs", "loader.rs", "natives.rs", "program.rs", "transport.rs", "value_natives.rs", "side_modules.rs", "transfer.rs", "nested_bridge.rs", "nested_token.rs", "transfer_fault.rs"]
  .map(file => `crates/bunwasm-engine-quickjs/src/${file}`).concat(["scripts/src/engine-init.c", "scripts/src/engine-explicit-init.ts", "crates/bunwasm-engine-quickjs/group-errno.c", "crates/bunwasm-engine-quickjs/build/transfer_fault.rs", "scripts/src/transfer-fault.sh", "scripts/src/group-errno-wraps.sh"]);
function coverageEnginesForPath(path: string): CoverageEngine[] {
  if (pairedSideFiles.includes(path)) return ["quickjs", "jsc"];
  return (["browser", "quickjs", "jsc"] as const).filter(engine => touches(path, engineRoots[engine], engineFiles[engine]));
}
