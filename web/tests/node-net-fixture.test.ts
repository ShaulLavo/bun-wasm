import { expect, test } from "bun:test";
import { getDefaultHighWaterMark } from "node:stream";
import { networkFixture } from "./node-net-fixture";

test("network fixture composes the Server constructor's stream defaults without listening", () => {
  const fixture = networkFixture();
  const server = fixture.net.createServer();
  expect(server).toHaveProperty("highWaterMark", getDefaultHighWaterMark(false));
  expect(server.listening).toBe(false);
  expect(server.address()).toBeNull();
  expect(fixture.closed).toEqual([]);
});
