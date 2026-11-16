import { expect, test } from "bun:test";
import { IphoneBus } from "./iphone-bus";
import type { IphoneResponseObservation } from "./iphone-responses";

const origin = "http://127.0.0.1:41001";
const preview = origin + "/__preview/5173/";
const endpoint = "http://127.0.0.1:41002/test/preview/response/";
function post(bus: IphoneBus, action: string, body: unknown, from = origin): Promise<Response> {
  return bus.handle(new Request(endpoint + action, { method: "POST", headers: { origin: from, "content-type": "application/json" }, body: JSON.stringify(body) }), origin);
}
async function grant(bus: IphoneBus): Promise<{ id: string; nonce: string; url: string }> {
  const response = await post(bus, "start", { url: preview, method: "GET" });
  expect(response.status).toBe(200);
  const row: unknown = await response.json();
  if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string" || !("nonce" in row) || typeof row.nonce !== "string" || !("url" in row) || typeof row.url !== "string") throw new Error("Invalid granted response identity");
  return { id: row.id, nonce: row.nonce, url: row.url };
}
async function fixture(run: (bus: IphoneBus, rows: IphoneResponseObservation[]) => Promise<void>): Promise<void> {
  const rows: IphoneResponseObservation[] = [];
  const bus = new IphoneBus("/test", row => rows.push(row));
  bus.configure("preview", preview);
  try { await run(bus, rows); }
  finally { bus.close(); }
}

test("response capture binds a head to the configured nonce, URL and request without retaining unknown data", () => fixture(async (bus, rows) => {
  const key = await grant(bus);
  const response = await post(bus, "event", { ...key, event: "head", sequence: 1, clientAt: Date.now(), status: 200, contentType: "text/html", contentEncoding: null, contentLength: "123", unrequested: { body: "must not be retained" } });
  expect(response.status).toBe(204);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ...key, event: "head", status: 200, contentType: "text/html", contentLength: "123", method: "GET", currentNonce: key.nonce, sameConfiguration: true });
  expect(rows[0]).not.toHaveProperty("unrequested");
  expect(Object.values(rows[0]!).every(value => value === null || ["string", "number", "boolean"].includes(typeof value))).toBe(true);
  const snapshot = await bus.handle(new Request(endpoint + "state"), origin);
  expect(await snapshot.json()).toEqual(rows);
}));

test("unconfigured URLs, foreign origins and wrong response identities produce no observation", () => fixture(async (bus, rows) => {
  expect((await post(bus, "start", { url: origin + "/unconfigured", method: "GET" })).status).toBe(204);
  expect((await post(bus, "start", { url: preview, method: "GET" }, "http://127.0.0.1:41003")).status).toBe(403);
  const key = await grant(bus);
  expect((await post(bus, "event", { ...key, nonce: "wrong", event: "head", sequence: 1 })).status).toBe(403);
  expect((await post(bus, "event", { ...key, url: origin + "/unconfigured", event: "head", sequence: 1 })).status).toBe(403);
  expect((await bus.handle(new Request(endpoint + "state", { headers: { origin } }), origin)).status).toBe(403);
  expect(rows).toEqual([]);
}));

test("response capture rejects non-scalar fields and bounded text overflow", () => fixture(async (bus, rows) => {
  const key = await grant(bus);
  expect((await post(bus, "event", { ...key, event: "head", sequence: 1, contentType: { buffer: [1, 2] } })).status).toBe(400);
  expect((await post(bus, "event", { ...key, event: "failure", sequence: 1, error: "x".repeat(2049) })).status).toBe(400);
  expect((await post(bus, "event", { ...key, event: "head", sequence: 17 })).status).toBe(400);
  expect(rows).toEqual([]);
}));

test("a late response remains bound to its old document and cannot weaken replacement guards", () => fixture(async (bus, rows) => {
  const old = await grant(bus);
  bus.configure("preview", preview);
  const current = bus.state("preview")!;
  expect(current.nonce).not.toBe(old.nonce);
  expect((await post(bus, "event", { ...old, event: "body-end", sequence: 1, characters: 123 })).status).toBe(204);
  expect(rows[0]).toMatchObject({ nonce: old.nonce, currentNonce: current.nonce, sameConfiguration: false });
  expect(() => bus.poll("preview", { nonce: old.nonce, url: preview, timeOrigin: 1, visible: true }, origin)).toThrow("Wrong iPhone observer document");
}));

test("request grants are bounded and closing releases scalar response records", () => fixture(async (bus, rows) => {
  for (let index = 0; index < 32; index++) await grant(bus);
  expect((await post(bus, "start", { url: preview, method: "GET" })).status).toBe(204);
  bus.close();
  expect(rows).toEqual([]);
  expect(await (await bus.handle(new Request(endpoint + "state"), origin)).json()).toEqual([]);
}));
