import { expect, test } from "bun:test";
import { fixtureGuestResponse } from "./fixture-guest-response";

const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
const sources: readonly { name: string; guest: Blob | Uint8Array<ArrayBuffer> }[] = [
  { name: "verified bytes", guest: bytes }, { name: "file-like blob", guest: new Blob([bytes]) },
];

for (const { name, guest } of sources) test(`fixture guest serves matching plain and gzip representations from ${name}`, async () => {
  const plain = fixtureGuestResponse("/bun-guest.wasm", guest, headers);
  const gzip = fixtureGuestResponse("/bun-guest.wasm.gz", guest, headers);
  if (!plain || !gzip || !gzip.body) throw new Error("Expected both guest representations");
  expect(plain.status).toBe(200);
  expect(gzip.status).toBe(200);
  expect(plain.headers.get("Content-Type")).toBe("application/wasm");
  expect(gzip.headers.get("Content-Type")).toBe("application/gzip");
  expect(gzip.headers.get("Content-Encoding")).toBeNull();
  for (const [key, value] of Object.entries(headers)) expect(gzip.headers.get(key)).toBe(value);
  expect(new Uint8Array(await plain.arrayBuffer())).toEqual(bytes);
  const decoded = new Response(gzip.body.pipeThrough(new DecompressionStream("gzip")));
  expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(bytes);
});

test("fixture guest leaves unrelated and misspelled routes to the caller", () => {
  for (const path of ["/fixture.json", "/favicon.ico", "/bun-guest.wasm.gz.missing"]) expect(fixtureGuestResponse(path, bytes, headers)).toBeUndefined();
});
