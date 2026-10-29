import { expect, test } from "bun:test";
import { networkFixture } from "./node-net-fixture";

test("Node path listeners delegate to the Unix transport instead of rejecting Nuxt", () => {
  const fixture = networkFixture();
  const server = fixture.own(fixture.net.createServer());
  server.on("error", () => {});
  expect(() => server.listen({ path: "/tmp/nuxt-vite.sock" })).not.toThrow();
  server.close();
});
