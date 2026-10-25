import { expect, test } from "bun:test";
import { requestCopyContract } from "../tests/fixtures/runtime-request-copy/contract.ts";
import { requestCopyFactory } from "./request-copy-factory";

test.each(["polyfill", "native"] as const)("Request copying matches the Node ownership contract with %s streams", async kind => {
  expect(await requestCopyContract(requestCopyFactory(kind).web)).toBe("request copy contract");
});

test.each(["polyfill", "native"] as const)("fetch(request, headers) with %s streams uses the unchanged net factory", async kind => {
  const { web, net, internal, sent, closed } = requestCopyFactory(kind);
  const source = new web.Request("https://example.test/", {
    method: "POST", redirect: "manual",
    body: new web.ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("fetch payload")); controller.close(); } }),
  });
  const pending = net.fetch(source, { headers: { "x-copy": "yes" } });
  for (let tick = 0; tick < 100 && !internal.ioPending(); tick++) await Promise.resolve();
  expect(internal.ioPending()).toBe(1);
  internal.pumpIo();
  expect((await pending).status).toBe(204);
  expect(sent).toHaveLength(1);
  expect(new TextDecoder().decode(sent[0]!.body)).toBe("fetch payload");
  expect(JSON.parse(sent[0]!.meta)).toMatchObject({ method: "POST", redirect: "manual", headers: [["x-copy", "yes"], ["user-agent", "Bun/fixture"]] });
  expect(closed).toEqual([1]);
  expect(internal.ioPending()).toBe(0);
  expect(source.body?.locked).toBe(true);
});


test("explicit null replaces even a used body without transferring it, matching Bun", async () => {
  const { web } = requestCopyFactory();
  const source = new web.Request("https://example.test/", { method: "POST", body: "old", redirect: "manual" });
  await source.text();
  const replacement = new web.Request(source, { body: null });
  expect(replacement.body).toBeNull();
  expect(await replacement.text()).toBe("");
  expect(replacement.redirect).toBe("manual");
});
