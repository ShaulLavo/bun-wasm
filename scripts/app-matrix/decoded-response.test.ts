import { expect, test } from "bun:test";
import { decodedResponse } from "./decoded-response.ts";

test("recorder forwards fetch's decoded body without compressed response headers", async () => {
  const upstream = new Response('{"name":"esbuild-wasm"}', {
    status: 200,
    headers: { "content-encoding": "br", "content-length": "15", "content-type": "application/json" },
  });
  const recorded = await decodedResponse(upstream);
  expect(recorded.headers.has("content-encoding")).toBe(false);
  expect(recorded.headers.has("content-length")).toBe(false);
  expect(recorded.headers.get("content-type")).toBe("application/json");
  expect(await recorded.json()).toEqual({ name: "esbuild-wasm" });
});
