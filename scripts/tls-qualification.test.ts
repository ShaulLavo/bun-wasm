import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { parseTlsArguments } from "./tls-qualification.ts";
import { preflightTls, parseParentIntake, deliveryPath, fileIdentity, preflightReferences, verifyDependencyTree, readVerifiedFile, verifyReviewedHostSource, type TlsEvidence } from "./tls-qualification-inputs.ts";
import { qualifiedRun, TlsCleanup, acquireOwned, closeObservedCase } from "./tls-qualification-lifecycle.ts";
import { qualificationCases, assertCaseContext, assertPgResult } from "./tls-qualification-context.ts";
import { qualificationFixture } from "./tls-qualification-fixture.ts";
import { PgWireAudit } from "../web/tests/tls-relay-services.ts";

async function invalidFixture(change: (fixture: Awaited<ReturnType<typeof qualificationFixture>>) => Promise<void>, expected: RegExp, reseal = true) {
  const fixture = await qualificationFixture();
  let setups = 0;
  try {
    let inputs = await fixture.seal();
    await change(fixture);
    if (reseal) inputs = await fixture.seal();
    await expect(qualifiedRun(() => preflightTls(inputs), async () => { setups++; throw new Error("Setup must never run"); }, async () => {})).rejects.toThrow(expected);
    expect(setups).toBe(0);
  } finally { await fixture.close(); }
}
describe("TLS evidence is a gate before setup", () => {
  test("rejects CURRENT and a successful source-only status", () => {
    expect(() => parseParentIntake({ kind: "consumer-qualification-status-NOT-admission", ok: true }, { head: "a".repeat(40), tree: "b".repeat(40) }, "/fixture")).toThrow("Independent parent");
  });
  test("rejects parent source head mismatch", () => invalidFixture(async fixture => { fixture.parent.source = { head: "c".repeat(40), tree: "b".repeat(40) }; }, /source head\/tree/));
  test("rejects parent source tree mismatch", () => invalidFixture(async fixture => { fixture.parent.source = { head: "a".repeat(40), tree: "c".repeat(40) }; }, /source head\/tree/));
  test("rejects a runtime107 or missing relay tuple", () => invalidFixture(async fixture => { fixture.parent.tuple = { runtime: "0.0.107", hostInterface: 1, engines: ["quickjs", "jsc", "browser"] }; }, /runtime\/relay109/));
  test("rejects changed parent bytes before reading payloads", () => invalidFixture(async fixture => { await fixture.put(join(fixture.root, "parent.json"), { kind: "changed" }); }, /pinned evidence hash/, false));
  test("rejects changed artifact bytes before setup", () => invalidFixture(async fixture => { await fixture.put(join(fixture.delivery, "source.tar.gz"), "tampered"); }, /byte\/custody mismatch/, false));
  test("rejects missing parent custody", () => invalidFixture(async fixture => { fixture.parent.gates = {}; }, /parent custody/));
  test("rejects changed producer source", () => invalidFixture(async fixture => {
    const path = join(fixture.delivery, "inputs/ADMISSION.json");
    const value = JSON.parse(await readFile(path, "utf8")); value.source.head = "e".repeat(40); await fixture.put(path, value);
  }, /source head\/tree/));
  test("rejects before/after/preseal custody mismatch", () => invalidFixture(async fixture => { await fixture.put(join(fixture.delivery, "inputs/vendor-custody-after.json"), "changed custody"); }, /custody mismatch/));
  test("rejects mismatched canonical original bytes", () => invalidFixture(async fixture => {
    await fixture.put(join(fixture.delivery, "inputs/CANONICAL-REUSE.json"), { staged: [{ path: "source.tar.gz", originalPath: join(fixture.delivery, "source.tar.gz"), bytes: 1, sha256: "a".repeat(64) }] });
  }, /byte\/custody mismatch/));
  test("rejects symlinks and unsafe paths", async () => {
    expect(() => deliveryPath("/fixture", "../source")).toThrow("Unsafe");
    expect(() => deliveryPath("/fixture", "/source")).toThrow("Unsafe");
    await invalidFixture(async fixture => { await symlink("source.tar.gz", join(fixture.delivery, "extra")); }, /symlink/, false);
  });
  test("the externally pinned source release cannot be replaced by a self-asserted TLS flag", async () => {
    const fixture = await qualificationFixture();
    let setups = 0;
    try {
      const inputs = await fixture.seal();
      await expect(qualifiedRun(() => preflightTls({ ...inputs, sourceReleaseSha256: "0".repeat(64) }), async () => { setups++; }, async () => {})).rejects.toThrow("source release identity mismatch");
      expect(setups).toBe(0);
    } finally { await fixture.close(); }
  });
  test("missing evidence never invokes a factory", async () => {
    let setup = false;
    await expect(qualifiedRun(async () => { throw new Error("No reviewed TLS delivery"); }, async () => { setup = true; }, async () => {})).rejects.toThrow("No reviewed TLS");
    expect(setup).toBe(false);
  });
});
describe("future browser query context", () => {
  const result = { kind: "tls-pg-result", mode: "verified", ssl: true, sameBackend: true, version: "TLSv1.3", cipher: "TLS_AES_128_GCM_SHA256", bits: 128 };
  test("requires pg_stat_ssl on the same backend", () => {
    expect(assertPgResult(result, "verified").ssl).toBe(true);
    expect(() => assertPgResult({ ...result, ssl: false }, "verified")).toThrow();
    expect(() => assertPgResult({ ...result, sameBackend: false }, "verified")).toThrow();
    expect(() => assertPgResult({ select: 1 }, "verified")).toThrow();
  });
  test("preserves engine and forced WebSocket carrier", () => {
    const context = { engine: "browser", carrier: "websocket", connections: 1, lifecycle: { runtimeDisposed: true, liveConsumers: 0, relayActive: 0 }, result };
    expect(assertCaseContext(context, "verified", "browser").carrier).toBe("websocket");
    for (const override of [{ carrier: "webtransport" }, { engine: "jsc" }, { connections: 2 }, { runtimeDisposed: false }, { relayClosed: false }]) expect(() => assertCaseContext({ ...context, ...override }, "verified", "browser")).toThrow();
    expect(qualificationCases).toEqual(["verified", "no-extra-ca", "hostname", "rejection", "plaintext"]);
  });
  test("negative controls are separate and require rejection", () => {
    for (const mode of qualificationCases.filter(mode => mode !== "verified")) {
      expect(assertPgResult({ kind: "tls-pg-result", mode, rejected: true }, mode).rejected).toBe(true);
      expect(() => assertPgResult({ ...result, mode }, mode)).toThrow();
    }
  });
  test("actual guest source keeps literal ssl true and never imports page-native pg", async () => {
    const guest = await readFile(new URL("../web/tests/fixtures/tls/pg-client.ts", import.meta.url), "utf8");
    expect(guest).toContain('ssl: true');
    expect(guest).not.toContain('rejectUnauthorized: false');
    expect(guest).toContain("FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
    const page = await readFile(new URL("../web/tests/tls-relay-page.ts", import.meta.url), "utf8");
    expect(page.indexOf("await seed(runtime")).toBeLessThan(page.indexOf("active = startRun("));
    expect(page).toContain('NODE_EXTRA_CA_CERTS: "/home/user/tls/ca.pem"');
    expect(page).not.toContain('require("pg")');
    expect(page).not.toContain('import("pg")');
  });
});
describe("wire witnesses and cleanup", () => {
  const request = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
  test("handles fragmented SSLRequest and TLS headers without retaining payload", () => {
    const audit = new PgWireAudit("verified");
    for (const byte of Buffer.concat([request, Buffer.from([22, 3, 3, 0, 3, 1, 2, 3])])) audit.accept(Uint8Array.of(byte));
    expect(audit.result().sslRequests).toBe(1);
    expect(audit.result().plaintextStartupObserved).toBe(false);
  });
  test("detects plaintext startup and any bytes after SSL rejection", () => {
    const audit = new PgWireAudit("no-extra-ca"); audit.accept(Buffer.concat([request, Buffer.from([0, 0, 0, 9, 0, 3, 0, 0, 0])]));
    expect(() => audit.result()).toThrow("Plaintext");
    const rejection = new PgWireAudit("rejection"); rejection.accept(request.subarray(0, 7)); expect(rejection.sslRequests).toBe(0); rejection.accept(request.subarray(7)); expect(rejection.result().bytes).toBe(8);
    rejection.accept(Uint8Array.of(0)); expect(() => rejection.result()).toThrow();
  });
  test("setup failure still tears down all acquired resources once", async () => {
    const released: number[] = [];
    await expect(qualifiedRun(async () => "source-parser-only", async (_, owner) => {
      owner.add(() => { released.push(1); }); owner.add(() => { released.push(2); }); throw new Error("setup failed");
    }, async () => {})).rejects.toThrow("setup failed");
    expect(released).toEqual([2, 1]);
  });
  test("exercise failure and cleanup failure do not skip remaining teardown", async () => {
    const owner = new TlsCleanup(); const released: number[] = [];
    owner.add(() => { released.push(1); }); owner.add(() => { released.push(2); throw new Error("close failed"); });
    const closing = owner.close(); expect(owner.close()).toBe(closing); await expect(closing).rejects.toThrow("cleanup unconfirmed"); expect(released).toEqual([2, 1]);
    let stopped = false;
    await expect(qualifiedRun(async () => 1, async (_, cleanup) => { cleanup.add(() => { stopped = true; }); }, async () => { throw new Error("query failed"); })).rejects.toThrow("query failed");
    expect(stopped).toBe(true);
  });
  test("CLI fails closed before implicit paths or broad stages", () => {
    expect(() => parseTlsArguments([])).toThrow("--stage");
    expect(() => parseTlsArguments(["--stage", "full", "--browser", "chromium"])).toThrow("only pg-early");
    expect(() => parseTlsArguments(["--stage", "pg-early", "--browser", "firefox"])).toThrow("only pg-early");
    expect(() => parseTlsArguments(["--stage", "pg-early", "--stage", "pg-early"])).toThrow("repeated");
  });
});

async function reviewGate(change: (fixture: Awaited<ReturnType<typeof qualificationFixture>>, inputs: TlsEvidence) => Promise<TlsEvidence>, expected: RegExp) {
  const fixture = await qualificationFixture();
  let setups = 0;
  try {
    await fixture.authenticatedDependencies();
    const inputs = await change(fixture, await fixture.seal());
    await expect(qualifiedRun(() => preflightTls(inputs), async () => { setups++; }, async () => {})).rejects.toThrow(expected);
    expect(setups).toBe(0);
  } finally { await fixture.close(); }
}
describe("review corrections", () => {
  test("finding 1 rejects a relative original positive path", () => reviewGate(async fixture => {
    const original = join(fixture.delivery, "source.tar.gz");
    await fixture.reuseEntries([{ path: "source.tar.gz", originalPath: fixture.relativeOriginal(original), ...await fileIdentity(original) }]);
    return fixture.seal();
  }, /original.*absolute/i));
  test("finding 1 rejects an external canonical reuse reference", () => reviewGate(async (fixture, inputs) => {
    const external = join(fixture.root, "foreign-canonical.json");
    await fixture.put(external, { staged: [] });
    fixture.parent.canonicalReuse = { path: external, ...await fileIdentity(external) };
    return fixture.rewriteParent(inputs);
  }, /canonical reuse path mismatch/i));
  test("finding 1 rejects repeated staged delivery paths", () => reviewGate(async fixture => {
    const original = join(fixture.delivery, "source.tar.gz");
    const row = { path: "source.tar.gz", originalPath: original, ...await fileIdentity(original) };
    await fixture.reuseEntries([row, row]);
    return fixture.seal();
  }, /duplicate.*reuse/i));
  test("finding 1 rejects staged paths outside manifest membership", () => reviewGate(async fixture => {
    const original = join(fixture.delivery, "DELIVERY.json");
    await fixture.reuseEntries([{ path: "DELIVERY.json", originalPath: original, ...await fileIdentity(original) }]);
    return fixture.seal();
  }, /reuse.*manifest member/i));
  test("finding 2 rejects non-pg dependency links before setup", () => reviewGate(async (fixture, inputs) => {
    const tree = await fixture.dependencyTree();
    await symlink("../pg/package.json", join(tree.modules, "pg-protocol/link"));
    return { ...inputs, pgModules: tree.modules };
  }, /dependency.*(symlink|ordinary)/i));
  test("finding 2 requires complete authenticated pg dependency coverage before setup", () => reviewGate(async (fixture, inputs) => {
    const tree = await fixture.dependencyTree();
    await fixture.put(join(tree.modules, "pg-protocol/extra.js"), "not authenticated");
    return { ...inputs, pgModules: tree.modules };
  }, /missing authenticated.*pg.*dependency/i));
  test("finding 3 rejects ignored host dependencies without authenticated bytes", () => reviewGate(async (fixture, inputs) => {
    const host = join(fixture.root, "host");
    await fixture.put(join(host, "web/node_modules/waffle/package.json"), { version: "0.0.109" });
    await fixture.put(join(host, "web/node_modules/waffle/index.ts"), "modified ignored code");
    return { ...inputs, hostSource: host };
  }, /missing authenticated.*host.*dependency/i));
  test("finding 4 rejects lifecycle booleans without observations", () => {
    const result = { kind: "tls-pg-result", mode: "verified", ssl: true, sameBackend: true, version: "TLSv1.3", cipher: "TLS_AES_128_GCM_SHA256", bits: 128 };
    expect(() => assertCaseContext({ engine: "browser", carrier: "websocket", connections: 1, runtimeDisposed: true, relayClosed: true, result }, "verified", "browser")).toThrow(/lifecycle.*observations/i);
  });
  test("finding 5 cancellation after validation never calls setup", async () => {
    const abort = new AbortController();
    let setups = 0;
    const validate = async () => { abort.abort(new Error("cancel after validation")); return 1; };
    await expect(qualifiedRun(validate, async () => { setups++; }, async () => {}, abort.signal)).rejects.toThrow("cancel after validation");
    expect(setups).toBe(0);
  });
  test("follow-up 1 qualified cleanup releases a late resource after abort", async () => {
    const abort = new AbortController();
    const deferred = Promise.withResolvers<string>();
    const owner = new TlsCleanup();
    let released = false;
    const acquisition = acquireOwned(owner, abort.signal, () => deferred.promise, () => { released = true; });
    abort.abort(new Error("late resource"));
    await expect(acquisition).rejects.toThrow("late resource");
    deferred.resolve("resource");
    await owner.close();
    expect(released).toBe(true);
  });
  test("follow-up 2 mutation after preflight rejects the guest artifact before use", async () => {
    const fixture = await qualificationFixture();
    try {
      const path = join(fixture.delivery, "browser/default/bun-browser.wasm");
      const identity = { path, ...await fileIdentity(path) };
      await readVerifiedFile(identity);
      await writeFile(path, "mutated guest bytes");
      await expect(readVerifiedFile(identity)).rejects.toThrow("byte/custody mismatch");
    } finally { await fixture.close(); }
  });
  test("follow-up 3 tracked source mutation after preflight is rejected", async () => {
    const root = await mkdtemp("/work/tmp/bun-wasm-tls-host-source-");
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "tls@test.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "TLS test"]);
      await writeFile(join(root, "tracked.ts"), "original");
      execFileSync("git", ["-C", root, "add", "tracked.ts"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "source"]);
      const expected = { head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), tree: execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim() };
      await writeFile(join(root, "tracked.ts"), "mutated");
      await expect(verifyReviewedHostSource(root, expected)).rejects.toThrow("clean reviewed source");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("follow-up 4 result source includes exact host dependency projections and bound", async () => {
    const page = await readFile(new URL("../web/tests/tls-relay-browser.ts", import.meta.url), "utf8");
    expect(page).toContain("hostDependencies: intake.dependencies.host");
    expect(page).toContain("frozenLocks: intake.dependencies.locks");
    const cli = await readFile(new URL("./tls-qualification.ts", import.meta.url), "utf8");
    expect(cli).toContain("256 * 1024");
  });
});

describe("review byte and observation controls", () => {
  test("finding 2 changed non-pg dependency bytes never reach setup or a resource ledger", () => reviewGate(async (fixture, inputs) => {
    await fixture.put(join(inputs.pgModules, "pg-protocol/index.js"), "changed non-pg bytes");
    return inputs;
  }, /byte\/custody mismatch/));
  test("finding 3 unchanged version cannot authenticate changed ignored host code", () => reviewGate(async (fixture, inputs) => {
    await fixture.put(join(inputs.hostSource, "web/node_modules/waffle-relay/index.ts"), "changed ignored host code");
    const metadata = JSON.parse(await readFile(join(inputs.hostSource, "web/node_modules/waffle-relay/package.json"), "utf8"));
    expect(metadata.version).toBe("0.0.109");
    return inputs;
  }, /byte\/custody mismatch/));
  test("findings 2 and 3 only complete authenticated tree bytes can be used", async () => {
    const fixture = await qualificationFixture();
    try {
      const { tree } = await fixture.authenticatedDependencies();
      const captured = await verifyDependencyTree(tree.modules, tree.expected, "pg");
      expect(captured.files).toHaveLength(2);
      const dependency = tree.expected.find(row => row.path.endsWith("pg-protocol/index.js"));
      if (!dependency) throw new Error("Parser control dependency missing");
      await fixture.put(dependency.path, "changed after preflight");
      await expect(readVerifiedFile(dependency)).rejects.toThrow("before use");
    } finally { await fixture.close(); }
  });
  test("finding 4 captures exact absolute preflight references, not just a source tuple", async () => {
    const fixture = await qualificationFixture();
    try {
      const inputs = await fixture.seal();
      const manifest = JSON.parse(await readFile(join(fixture.delivery, "DELIVERY.json"), "utf8"));
      const references = await preflightReferences(inputs, fixture.parent, manifest.files);
      expect(references).toHaveLength(15);
      for (const reference of references) expect(reference).toEqual({ path: reference.path, ...await fileIdentity(reference.path) });
      expect(references.map(row => row.path)).toContain(inputs.admission);
      for (const name of ["DELIVERY.json", "inputs/ADMISSION.json", "inputs/CANONICAL-REUSE.json", "source.tar.gz", "inputs/native-custody-preseal.json"]) expect(references.map(row => row.path)).toContain(join(fixture.delivery, name));
      expect(JSON.stringify(references)).not.toContain("password");
      await fixture.put(inputs.admission, "changed intake after validation");
      await expect(preflightReferences(inputs, fixture.parent, manifest.files)).rejects.toThrow("changed before reference capture");
    } finally { await fixture.close(); }
  });
  test("finding 4 disposal/close failures and live consumers cannot report success", async () => {
    let closes = 0;
    await expect(closeObservedCase({ dispose: async () => { throw new Error("dispose failed"); }, close: async () => { closes++; }, observe: () => ({ runtimeDisposed: true, liveConsumers: 0, relayActive: 0 }) })).rejects.toThrow("cleanup failed");
    expect(closes).toBe(1);
    await expect(closeObservedCase({ dispose: async () => {}, close: async () => { throw new Error("close failed"); }, observe: () => ({ runtimeDisposed: true, liveConsumers: 0, relayActive: 0 }) })).rejects.toThrow("cleanup failed");
    for (const observations of [{ runtimeDisposed: true, liveConsumers: 1, relayActive: 0 }, { runtimeDisposed: true, liveConsumers: 0, relayActive: 1 }, { runtimeDisposed: false, liveConsumers: 0, relayActive: 0 }, undefined]) {
      await expect(closeObservedCase({ dispose: async () => {}, close: async () => {}, observe: () => observations })).rejects.toThrow("lifecycle observations");
    }
  });
  test("finding 4 observations happen after both real cleanup callbacks", async () => {
    const events: string[] = [];
    let liveConsumers = 1, relayActive = 1, runtimeDisposed = false;
    const result = await closeObservedCase({ dispose: async () => { liveConsumers--; runtimeDisposed = true; events.push("dispose"); }, close: async () => { relayActive--; events.push("close"); }, observe: () => { events.push("observe"); return { runtimeDisposed, liveConsumers, relayActive }; } });
    expect(result).toEqual({ runtimeDisposed: true, liveConsumers: 0, relayActive: 0 });
    expect(events).toEqual(["dispose", "close", "observe"]);
  });
  test("finding 5 cancellation before and during every owned acquisition unwinds prior resources", async () => {
    const boundaries = ["remote-owner", "proxy", "listener", "relay", "relay-listener", "page-server", "browser", "context", "page", "guest"];
    for (const during of [false, true]) {
      for (let boundary = 0; boundary < boundaries.length; boundary++) await acquisitionCancellation(boundary, during, boundaries);
    }
  });
  test("finding 5 abort after setup prevents exercise and still closes its owner", async () => {
    const abort = new AbortController(); let exercised = false, released = false;
    await expect(qualifiedRun(async () => 1, async (_, owner) => {
      await acquireOwned(owner, abort.signal, () => "parser resource", () => { released = true; });
      abort.abort(new Error("after setup"));
    }, async () => { exercised = true; }, abort.signal)).rejects.toThrow("after setup");
    expect(exercised).toBe(false); expect(released).toBe(true);
  });
});
async function acquisitionCancellation(boundary: number, during: boolean, boundaries: readonly string[]) {
  const fixture = await qualificationFixture();
  const abort = new AbortController();
  const acquired: string[] = [], released: string[] = [];
  try {
    await expect(qualifiedRun(async () => 1, async (_, owner) => {
      for (const [index, label] of boundaries.entries()) {
        if (index === boundary && !during) abort.abort(new Error("boundary cancelled"));
        await acquireOwned(owner, abort.signal, async () => {
          const path = join(fixture.root, `${label}.parser-resource`);
          await fixture.put(path, "synthetic lifecycle resource, never a service"); acquired.push(path);
          if (index === boundary && during) abort.abort(new Error("boundary cancelled"));
          return path;
        }, async path => { const { rm } = await import("node:fs/promises"); await rm(path); released.push(path); });
      }
    }, async () => {}, abort.signal)).rejects.toThrow("boundary cancelled");
    expect(acquired).toHaveLength(boundary + Number(during));
    expect(released).toEqual(acquired.toReversed());
    for (const path of acquired) await expect(readFile(path)).rejects.toHaveProperty("code", "ENOENT");
  } finally { await fixture.close(); }
}
