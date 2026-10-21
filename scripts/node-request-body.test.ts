import { test } from "bun:test";
import { verifyRequestBodies, verifyIncomingRequestBody } from "../tests/fixtures/request-body-streams/contract";
import { requestBodyFixture } from "./node-request-body-fixture";

test("production Request consumes Node and async-iterable bodies without stringification", async () => {
  const fixture = requestBodyFixture();
  await verifyRequestBodies(fixture.create, fixture.stream);
});

test("production Request consumes the unchanged JSON POST from a real Node IncomingMessage", async () => {
  await verifyIncomingRequestBody(requestBodyFixture().create);
});
