import assert from "node:assert/strict";
import { verifyRequestBodies, verifyIncomingRequestBody } from "./contract.ts";

function create(body: unknown, method = "POST"): object {
  const request: unknown = Reflect.construct(Request, ["http://127.0.0.1/api/next", { method, headers: { "content-type": "application/json" }, body, duplex: "half" }]);
  assert.ok(request && typeof request === "object");
  return request;
}
await verifyRequestBodies(create);
await verifyIncomingRequestBody(create);
console.log("Request async bodies preserve bytes, ordering, errors, cancellation and single consumption");
