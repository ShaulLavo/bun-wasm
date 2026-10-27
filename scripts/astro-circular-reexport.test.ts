import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-astro-reexport-"));
const probe = join(scratch, "target/debug/astro-circular-reexport");
function cleanup() { rmSync(scratch, { recursive: true, force: true }); }
process.once("SIGTERM", () => { cleanup(); process.exit(143); });
process.once("SIGINT", () => { cleanup(); process.exit(130); });

function writeModules(name: string, modules: Record<string, string>) {
  const directory = join(scratch, name);
  mkdirSync(directory);
  for (const [file, source] of Object.entries(modules)) writeFileSync(join(directory, file), source);
}

const concrete = 'let Fragment = Symbol.for("astro:fragment");\nfunction setFragment(value) { Fragment = value; }\nexport { Fragment, setFragment };\n';
const indirect = 'import { Fragment } from "./common.mjs";\nexport { Fragment };\n';
const server = 'import { isVNode } from "./jsx-runtime.mjs";\nimport { Fragment } from "./render.mjs";\nexport { Fragment, isVNode };\n';
const jsxRuntime = (parent: string) => `import { Fragment } from "./${parent}.mjs";\nconst AstroJSX = "astro:jsx";\nfunction isVNode(value) { return value && typeof value === "object" && value[AstroJSX]; }\nexport { Fragment, isVNode };\n`;
const validEntries: Record<string, string[]> = {
  deep: ["server", "jsx-runtime", "render", "common"],
  deeper: ["server", "jsx-runtime", "render", "common", "concrete"],
  astro: ["server", "jsx", "jsx-runtime", "render", "common"],
  duplicate: ["server", "jsx-runtime", "render", "common"],
};
const adjacentEntries: Record<string, string[]> = {
  minimal: ["server", "jsx-runtime", "render"],
  direct: ["server", "jsx-runtime", "render", "common"],
  local: ["server", "jsx-runtime"],
  acyclic: ["server", "jsx-runtime", "render", "common"],
};
const allValidEntries = { ...validEntries, ...adjacentEntries };
const concreteModules: Record<string, string> = { deeper: "concrete", minimal: "render", local: "server" };

function forEachEntry(groups: Record<string, string[]>, run: (graph: string, entry: string) => void) {
  for (const [graph, entries] of Object.entries(groups)) {
    for (const entry of entries) run(graph, entry);
  }
}

function forEachValidEntry(run: (graph: string, entry: string) => void) {
  forEachEntry(validEntries, run);
}

function forEachAdjacentEntry(run: (graph: string, entry: string) => void) {
  forEachEntry(adjacentEntries, run);
}

function forEachEveryValidEntry(run: (graph: string, entry: string) => void) {
  forEachEntry(allValidEntries, run);
}

function forEachNegativeEntry(run: (graph: string, entry: string) => void) {
  for (const graph of ["unresolved", "tdz"]) {
    const entries = graph === "unresolved" ? ["a", "b"] : ["server", "jsx-runtime"];
    for (const entry of entries) run(graph, entry);
  }
}

function writeValidGraphs() {
  const cycle = { "server.mjs": server, "jsx-runtime.mjs": jsxRuntime("server"), "render.mjs": indirect, "common.mjs": concrete };
  writeModules("deep", cycle);
  writeModules("deeper", {
    "server.mjs": server,
    "jsx-runtime.mjs": jsxRuntime("server"),
    "render.mjs": indirect,
    "common.mjs": 'import { Fragment } from "./concrete.mjs";\nexport { Fragment };\n',
    "concrete.mjs": concrete,
  });
  writeModules("astro", {
    "server.mjs": 'import { renderJSX } from "./jsx.mjs";\nimport { Fragment } from "./render.mjs";\nexport { Fragment, renderJSX };\n',
    "jsx.mjs": 'import { isVNode } from "./jsx-runtime.mjs";\nfunction renderJSX(value) { return isVNode(value); }\nexport { renderJSX };\n',
    "jsx-runtime.mjs": jsxRuntime("server"),
    "render.mjs": indirect,
    "common.mjs": concrete,
  });
  writeModules("duplicate", {
    "server.mjs": server,
    "jsx-runtime.mjs": 'import { Fragment, Fragment as Fragment2 } from "./server.mjs";\nconst AstroJSX = "astro:jsx";\nfunction isVNode(value) { return value && typeof value === "object" && value[AstroJSX]; }\nexport { Fragment, Fragment2, isVNode };\n',
    "render.mjs": indirect,
    "common.mjs": concrete,
  });
}

function writeAdjacentGraphs() {
  writeModules("minimal", { "server.mjs": server, "jsx-runtime.mjs": jsxRuntime("server"), "render.mjs": concrete });
  writeModules("direct", {
    "server.mjs": 'import { isVNode } from "./jsx-runtime.mjs";\nexport { Fragment } from "./render.mjs";\nexport { isVNode };\n',
    "jsx-runtime.mjs": jsxRuntime("server"), "render.mjs": indirect, "common.mjs": concrete,
  });
  writeModules("local", {
    "server.mjs": 'import { isVNode } from "./jsx-runtime.mjs";\nlet Fragment = Symbol.for("astro:fragment");\nfunction setFragment(value) { Fragment = value; }\nexport { Fragment, setFragment, isVNode };\n',
    "jsx-runtime.mjs": jsxRuntime("server"),
  });
  writeModules("acyclic", { "server.mjs": server, "jsx-runtime.mjs": jsxRuntime("render"), "render.mjs": indirect, "common.mjs": concrete });
}

function writeNegativeGraphs() {
  writeModules("unresolved", {
    "a.mjs": 'import { Fragment } from "./b.mjs";\nexport { Fragment };\n',
    "b.mjs": 'import { Fragment } from "./a.mjs";\nexport { Fragment };\n',
  });
  writeModules("tdz", {
    "server.mjs": 'import { value } from "./jsx-runtime.mjs";\nexport const Fragment = "server";\nexport const result = value;\n',
    "jsx-runtime.mjs": 'import { Fragment } from "./server.mjs";\nexport const value = Fragment;\n',
  });
}

function wrapperSource(graph: string, entry: string) {
  const concrete = concreteModules[graph] ?? "common";
  const duplicate = graph === "duplicate"
    ? 'import * as duplicate from "./jsx-runtime.mjs";\nif (duplicate.Fragment2 !== Fragment) throw new Error("duplicate alias mismatch");\n'
    : "";
  const duplicateUpdate = graph === "duplicate"
    ? 'if (duplicate.Fragment2 !== updated) throw new Error("duplicate alias is not live");\n'
    : "";
  return `import * as selected from "./${entry}.mjs";\nimport * as server from "./server.mjs";\nimport { Fragment, setFragment } from "./${concrete}.mjs";\nif (server.Fragment !== Fragment) throw new Error("Fragment namespace mismatch");\nif (Fragment !== Symbol.for("astro:fragment")) throw new Error("Fragment concrete identity mismatch");\n${duplicate}if (typeof selected.isVNode === "function" && selected.isVNode({ ["astro:jsx"]: true }) !== true) throw new Error("isVNode import mismatch");\nif (typeof selected.renderJSX === "function" && selected.renderJSX({ ["astro:jsx"]: true }) !== true) throw new Error("renderJSX import mismatch");\nconst updated = { live: true };\nsetFragment(updated);\nif (server.Fragment !== updated || Fragment !== updated) throw new Error("Fragment binding is not live");\n${duplicateUpdate}`;
}

function prepareNativeProbe() {
  writeValidGraphs();
  writeAdjacentGraphs();
  writeNegativeGraphs();
  forEachEveryValidEntry((graph, entry) => {
    writeFileSync(join(scratch, graph, `check-${entry}.mjs`), wrapperSource(graph, entry));
  });
  const cargoHome = join(scratch, "cargo-home");
  mkdirSync(cargoHome);
  const sharedCargo = process.env.CARGO_HOME;
  if (!sharedCargo) throw new Error("CARGO_HOME is required for the offline QuickJS control");
  symlinkSync(join(sharedCargo, "registry"), join(cargoHome, "registry"), "dir");
  const manifest = `[package]\nname = "astro-circular-reexport"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\nrquickjs = { version = "=0.13.0", default-features = false, features = ["std", "loader", "array-buffer"] }\n\n[patch.crates-io]\nrquickjs-sys = { path = "${root}third_party/rquickjs-sys" }\n`;
  writeFileSync(join(scratch, "Cargo.toml"), manifest);
  mkdirSync(join(scratch, "src"));
  writeFileSync(join(scratch, "src/main.rs"), readFileSync(new URL("fixtures/astro-circular-reexport/module-probe.rs", import.meta.url)));
  console.log(JSON.stringify({ prerequisite: "offline-quickjs", scratch, cargoBuildJobs: process.env.CARGO_BUILD_JOBS ?? "default" }));
  const result = spawnSync("cargo", ["build", "--offline", "--manifest-path", join(scratch, "Cargo.toml")], {
    cwd: root,
    env: { ...process.env, CARGO_HOME: cargoHome, CARGO_NET_OFFLINE: "true", CARGO_TARGET_DIR: join(scratch, "target") },
    encoding: "utf8",
    timeout: 120_000,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

afterAll(cleanup);
try {
  prepareNativeProbe();
} catch (error) {
  cleanup();
  throw error;
}

function observe(command: string, entry: string) {
  const result = spawnSync(command, [entry], { encoding: "utf8", timeout: 30_000 });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? "",
    output: `${result.stdout}${result.stderr}`,
  };
}

function quickJs(graph: string, entry = "server", wrapped = false) {
  const module = wrapped ? `check-${entry}` : entry;
  return observe(probe, join(scratch, graph, `${module}.mjs`));
}

function expectPass(result: ReturnType<typeof quickJs>) {
  expect(result.error).toBe("");
  expect(result.signal).toBeNull();
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("PASS module-contract");
}

function expectBoundedFailure(graph: string, entry: string, pattern: RegExp) {
  const result = quickJs(graph, entry);
  expect(result.error).toBe("");
  expect(result.signal).toBeNull();
  expect(result.status, result.output).toBe(2);
  expect(result.output).toMatch(pattern);
}

test("QuickJS resolves live two-plus-hop bindings and duplicate aliases from every entry", () => {
  forEachValidEntry((graph, entry) => expectPass(quickJs(graph, entry, true)));
});

test("QuickJS preserves one-hop, direct, local and acyclic binding contracts", () => {
  forEachAdjacentEntry((graph, entry) => expectPass(quickJs(graph, entry, true)));
});

test("genuine unresolved cycles fail boundedly with a circular diagnostic", () => {
  for (const entry of ["a", "b"]) expectBoundedFailure("unresolved", entry, /circular/i);
});

test("circular evaluation preserves TDZ ReferenceError", () => {
  for (const entry of ["server", "jsx-runtime"]) expectBoundedFailure("tdz", entry, /ReferenceError/);
});

test("Node and Bun accept every valid graph and entry with live bindings", () => {
  for (const runtime of ["node", "bun"]) {
    forEachEveryValidEntry((graph, entry) => {
      const result = observe(runtime, join(scratch, graph, `check-${entry}.mjs`));
      expect(result.error).toBe("");
      expect(result.signal).toBeNull();
      expect(result.status, result.output).toBe(0);
    });
  }
});

test("Node and Bun preserve unresolved-cycle and TDZ failures", () => {
  for (const runtime of ["node", "bun"]) {
    forEachNegativeEntry((graph, entry) => {
      const result = observe(runtime, join(scratch, graph, `${entry}.mjs`));
      expect(result.error).toBe("");
      expect(result.signal).toBeNull();
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(graph === "tdz" ? /ReferenceError/ : /Fragment/);
    });
  }
});
