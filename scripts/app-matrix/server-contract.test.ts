import { expect, test } from "bun:test";
import { apps, browserSubset } from "./apps.mjs";
import { registry, recorderErrorHeader } from "./registry.mjs";
import { assertServerResponse, serverCases, verifyServerContract, type ServerResponse } from "./server-contract.ts";
import { serverIds } from "./server-fixtures.ts";

const [getCase] = serverCases("express", "known");
if (!getCase) throw new Error("Missing GET fixture");
const correct: ServerResponse = { status: 200, headers: { "x-matrix-framework": "express", "x-matrix-token": "known", "content-type": "application/json" }, body: JSON.stringify(getCase.json) };

test("all real server fixtures are included in the literal-browser subset", () => {
  expect(serverIds).toHaveLength(5);
  for (const id of serverIds) {
    expect(browserSubset).toContain(id);
    expect(apps.find(app => app.id === id)?.commands[0]?.check.framework).toBe(id);
  }
});

test("offline and recording entry points share the exported recorder header", () => {
  expect(typeof registry).toBe("function");
  expect(recorderErrorHeader).toBe("x-bun-wasm-recorder-error");
});

test("server contract rejects root-only text, fixed JSON, missing middleware and wrong status", () => {
  expect(() => assertServerResponse("express", getCase, correct)).not.toThrow();
  expect(() => assertServerResponse("express", getCase, { ...correct, body: "bun-wasm app matrix" })).toThrow();
  expect(() => assertServerResponse("express", getCase, { ...correct, body: '{"framework":"express","id":"fixed","tag":"fixed"}' })).toThrow("JSON mismatch");
  expect(() => assertServerResponse("express", getCase, { ...correct, headers: {} })).toThrow("middleware header");
  expect(() => assertServerResponse("express", getCase, { ...correct, status: 201 })).toThrow("expected HTTP 200");
});

test("server contract changes the challenge every run and rejects success on negative routes", async () => {
  expect(serverCases("hono")[0]?.path).not.toBe(serverCases("hono")[0]?.path);
  const negatives = serverCases("express", "known").filter(request => request.status >= 400);
  expect(negatives).toHaveLength(3);
  for (const request of negatives) expect(() => assertServerResponse("express", request, correct)).toThrow(`expected HTTP ${request.status}`);
  await expect(verifyServerContract("express", async () => correct)).rejects.toThrow();
});

test("server contract records actual requests and responses before a failure", async () => {
  const observed: unknown[] = [];
  await expect(verifyServerContract("express", async () => correct, observation => { observed.push(observation); })).rejects.toThrow("middleware did not echo request challenge");
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ response: correct });
});
