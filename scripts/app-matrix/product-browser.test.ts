import { expect, test } from "bun:test";
import { completeObservations, observeProductTraffic, productObservations, type ProductPage } from "./product-browser";
import type { ProductCheck } from "./product-types";

function fixture() {
  let visible = "original";
  let source = "original";
  let frame: (() => void) | undefined;
  const visits: string[] = [];
  const writes: string[] = [];
  const locator = (wanted = "") => ({
    filter: ({ hasText }: { hasText: string }) => locator(hasText),
    async waitFor() { if (!visible.includes(wanted)) throw new Error("DOM did not update"); },
    async click() { visible = "action-result"; },
  });
  const page: ProductPage = {
    locator,
    async goto(url) {
      visits.push(url);
      visible = "route-result";
      return { ok: () => true, status: () => 200, text: async () => visible, headers: () => ({ "x-matrix": "verified" }) };
    },
    on(_event, listener) { listener({ on(_name, callback) { frame = () => callback({ payload: "update" }); } }); },
    off() { frame = undefined; },
  };
  return {
    page, visits, writes,
    source: {
      read: async () => source,
      async write(_path: string, contents: string) { writes.push(contents); source = contents; visible = contents; frame?.(); },
    },
    current: () => source,
  };
}

test("guest HMR edits restore source and observe a development update without navigation", async () => {
  const run = fixture();
  const traffic = observeProductTraffic(run.page);
  const check = { kind: "page", selector: "h1", text: "original", hmr: { path: "page.tsx", search: "original", replacement: "changed" } } satisfies ProductCheck;
  const rows = await productObservations(run.page, "http://local/__preview/3137/", check, run.source, traffic, 1000);
  expect(rows.map(row => row.status)).toEqual(["pass"]);
  expect(run.writes).toEqual(["changed", "original"]);
  expect(run.current()).toBe("original");
  expect(run.visits).toEqual([]);
  traffic.close();
});

test("a DOM change without HMR traffic cannot pass the hot-edit gate", async () => {
  const run = fixture();
  const check = { kind: "page", selector: "h1", text: "original", hmr: { path: "page.tsx", search: "original", replacement: "changed" } } satisfies ProductCheck;
  const rows = await productObservations(run.page, "http://local/", check, run.source, { count: () => 0 }, 1000);
  expect(rows[0]?.status).toBe("fail");
  expect(rows[0]?.blocker).toContain("without a development WebSocket");
  expect(run.current()).toBe("original");
});

test("feature requests retain the service-worker preview prefix and assert actual responses", async () => {
  const run = fixture();
  const check = { kind: "page", selector: "h1", text: "original", probes: [
    { kind: "route", id: "ssr", path: "/server", selector: "h1", text: "route-result" },
    { kind: "action", id: "action", path: "/action", button: "button", selector: "output", text: "action-result" },
    { kind: "response", id: "middleware", path: "/api", status: 200, header: { name: "X-Matrix", value: "verified" } },
  ] } satisfies ProductCheck;
  const rows = await productObservations(run.page, "http://local/__preview/3137/", check, run.source, { count: () => 0 }, 1000);
  expect(rows.map(row => row.status)).toEqual(["pass", "pass", "pass"]);
  expect(run.visits).toEqual(["http://local/__preview/3137/server", "http://local/__preview/3137/action", "http://local/__preview/3137/api"]);
});

test("unrun hot-edit and feature stages stay blocked rather than disappearing or passing", () => {
  const check = { kind: "page", selector: "h1", text: "original", hmr: { path: "page.tsx", search: "original", replacement: "changed" }, probes: [
    { kind: "route", id: "ssr", path: "/server", selector: "h1", text: "route-result" },
  ] } satisfies ProductCheck;
  expect(completeObservations(check, [], { status: "fail", blocker: "HTTP 500" })).toEqual([
    { stage: "hmr", status: "blocked", blocker: "HTTP 500" },
    { stage: "ssr", status: "blocked", blocker: "HTTP 500" },
  ]);
});
