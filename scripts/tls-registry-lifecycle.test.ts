import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const runtime = source("crates/bunwasm-runtime/src/lib.rs");
const natives = source("crates/bunwasm-runtime/src/natives.rs");
const split = source("crates/bunwasm-runtime/src/split.rs");
const tls = source("crates/bunwasm-runtime/src/tls.rs");
const bindings = source("crates/bunwasm-runtime/src/tls/bindings.rs");
const trust = source("crates/bunwasm-runtime/src/tls/trust.rs");
const bootstrap = source("crates/bunwasm-runtime/src/js/bootstrap.js");
const launcher = source("crates/bunwasm-host/src/main.rs");

function fieldIndex(text: string, field: string, start = 0): number {
  const index = text.indexOf(field, start);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("process-owned TLS registry source contract", () => {
  test("registers one shared typed registry with the existing data-native table", () => {
    expect(runtime).toContain("mod tls;");
    expect(runtime).not.toContain("#[cfg(test)]\nmod tls;");
    expect(runtime).toContain("tls: tls::SharedRegistry");
    expect(natives).toContain("crate::tls::install(&mut t, state.tls.clone());");
    for (const name of [
      "tlsCreateContext",
      "tlsCreateConnection",
      "tlsStep",
      "tlsAcceptIdentity",
      "tlsInspect",
      "tlsRelease",
      "tlsDispose",
    ]) {
      expect(bindings).toContain(`table.add("${name}"`);
    }
  });

  test("snapshots guest extra CA state once with absent and unavailable outcomes", () => {
    expect(trust).toContain('#[cfg(target_os = "wasi")]');
    expect(trust).toContain('std::env::var_os("NODE_EXTRA_CA_CERTS")');
    expect(trust).toContain("StartupExtras::Absent");
    expect(trust).toContain("StartupExtras::Unavailable");
    expect(trust).toContain("File::open");
    expect(trust).toContain(".take(MAX_MATERIAL as u64)");
    expect(runtime).toContain("tls::new_shared_registry(tls::snapshot_startup_extras())");
    expect(launcher).not.toContain("NODE_EXTRA_CA_CERTS");
  });

  test("disposal releases all native TLS ownership and blocks later allocation", () => {
    expect(tls).toContain("disposed: bool");
    expect(tls).toContain("self.connections.clear();");
    expect(tls).toContain("self.contexts.clear();");
    expect(tls).toContain("self.trust.dispose();");
    expect(tls).toContain('"ERR_TLS_REGISTRY_DISPOSED"');
    expect(tls).toContain("self.ensure_open()?;");
    expect(bindings).toContain("registry.dispose();");
  });

  test("terminal edges dispose without changing the normal browser handoff", () => {
    expect(runtime).toContain("self.dispose_tls();\n        self.directories.borrow_mut().close_all();");
    expect(split).toContain("let code = run(1);\n    state.dispose_tls();");
    const exit = bootstrap.slice(fieldIndex(bootstrap, "function emitExit"), fieldIndex(bootstrap, "internal.emitExit = emitExit"));
    const dispose = fieldIndex(exit, "native.tlsDispose();");
    const cancel = exit.lastIndexOf("internal.cancelIoWaiters();", dispose);
    const workerExit = fieldIndex(exit, "internal.workerExit");
    expect(cancel).toBeLessThan(dispose);
    expect(dispose).toBeLessThan(workerExit);
    expect(exit.slice(0, dispose)).toContain("process.emit(\"exit\", code)");
    expect(runtime).not.toContain("tls::new_shared_registry(tls::snapshot_startup_extras());\n        self.dispose_tls()");
  });
});
