import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { helper, sandbox, worker, networkProjection, providerPrelude, sha } from "./transforms";
import { qualify, type Row } from "./qualification";
const root = join(import.meta.dir, "../../..");
const original = (path: string) => execFileSync("git", ["show", `2f44db5644a75283c7b2157d3b2e4d3d54d486c0:${path}`], { cwd: root, encoding: "utf8" });
const router = await Bun.file(join(import.meta.dir, "source/preview.ts")).text();
const sw = await Bun.file(join(import.meta.dir, "source/service-worker.ts")).text();
const prelude = providerPrelude(router);
test("original Sandbox and worker transforms parse without changing the claim deadline", () => {
  const sandboxSource = original("sandbox/src/sandbox.ts");
  const transformed = sandbox(sandboxSource, prelude);
  new Bun.Transpiler({ loader: "ts" }).transformSync(transformed);
  const observed = worker(sw);
  expect(observed).toContain("options.claimTimeoutMs ?? 3000");
  new Bun.Transpiler({ loader: "ts" }).transformSync(observed);
  expect(transformed).toContain("this.previews.register(port, helper);");
  expect(transformed).toContain("this.previews.unregister(port, helper);");
  expect(() => sandbox(sandboxSource.replace("const sharedObjects =", "const wrong ="), prelude)).toThrow();
});
const target = "/?unique-control";
function positive() {
  const page = { generation: "page", runtimeId: 1, mainDocument: true, template: "hono" };
  const worker = { generation: "worker", realm: "worker", build: "build", scope: "https://test/sandbox/__preview/" };
  const raw: Row[] = [
    { kind: "forward", target, ask: 1 }, { kind: "claim-reply", ask: 1, reply: "accepted", acceptedReceipt: true },
    { kind: "claim-reply", ask: 1, reply: "head", payload: { status: 200 } }, { kind: "sw-fetch", url: "https://test/unique" },
    { kind: "evaluated-generation" }, { kind: "activated-generation" },
  ].map(row => ({ ...row, generation: "worker" }));
  raw.push(...[
    { kind: "runtime-router", router: 2, runtime: 1 }, { kind: "sandbox-listening", router: 2, helper: 3 },
    { kind: "register", router: 2, server: 3 }, { kind: "request-return", target, router: 2, current: 3, accepted: true },
    { kind: "helper-projection", helper: 4, capability: 3 }, { kind: "projection-request", target, helper: 4, capability: 3, closed: false },
    { kind: "helper-request-return", target, helper: 4, accepted: true, disposed: false }, { kind: "helper-connect", helper: 4, disposed: false },
  ].map(row => ({ ...row, generation: "page" })));
  return { rows: raw, target, url: "https://test/unique", build: "build", worker, page, response: { status: 200, body: "Hello from hono", fromServiceWorker: true } };
}
test("coverage gate rejects absent original-runtime links, native receipt, generation or body", () => {
  expect(qualify(positive()).armed).toBe(true);
  for (const kind of ["runtime-router", "sandbox-listening", "register", "helper-projection", "projection-request", "helper-request-return", "helper-connect", "activated-generation", "evaluated-generation", "sw-fetch"]) {
    const input = positive(); input.rows = input.rows.filter(row => row.kind !== kind);
    expect(() => qualify(input)).toThrow();
  }
  const noReceipt = positive(); noReceipt.rows = noReceipt.rows.filter(row => row.reply !== "accepted");
  expect(() => qualify(noReceipt)).toThrow();
  const wrong = positive(); wrong.worker.build = "wrong";
  expect(() => qualify(wrong)).toThrow();
  const noSW = positive(); noSW.response.fromServiceWorker = false;
  expect(() => qualify(noSW)).toThrow();
  const fakeBody = positive(); fakeBody.response.body = "fixture response";
  expect(() => qualify(fakeBody)).toThrow();
  const ambiguous = positive(); ambiguous.rows.push(ambiguous.rows[0]!);
  expect(() => qualify(ambiguous)).toThrow();
});
test("observer controllers parse and provider files retain explicit source identity", async () => {
  const names = ["capture.ts", "collector.ts", "supervise.ts", "teardown.ts", "instrument-build.ts", "inputs.ts"];
  for (const name of names) new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(join(import.meta.dir, name)).text());
  expect(sha(sw)).toBe("9c2ff1deaef93b9a5935b3398439723058b257992af108191203c7d3bc8481a1");
});

test("exact original helper and projection insertion parse and reject changed source", async () => {
  const source = await Bun.file(join(import.meta.dir, "source/helper-original.txt")).text();
  const projected = await Bun.file(join(import.meta.dir, "source/projection-original.txt")).text();
  new Bun.Transpiler({ loader: "ts" }).transformSync(helper(source, prelude));
  new Bun.Transpiler({ loader: "ts" }).transformSync(networkProjection(projected, prelude));
  expect(() => helper(source + "\n", prelude)).toThrow();
  expect(() => networkProjection(projected + "\n", prelude)).toThrow();
});
