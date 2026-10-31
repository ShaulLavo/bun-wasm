import assert from "node:assert/strict";
import type { Page } from "playwright";

const frameworks = ["express", "koa", "fastify", "hono", "elysia"];
export async function nextPageContract(page: Page, base: string, serviceWorker: boolean) {
  const responses: { url: string; status: number; serviceWorker: boolean }[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("response", response => responses.push({ url: response.url(), status: response.status(), serviceWorker: response.fromServiceWorker() }));
  const entered = await page.goto(new URL("framework/express", base).href);
  assert.equal(entered?.status(), 200, "nested page HTTP");
  assert.equal(entered?.fromServiceWorker(), serviceWorker, "nested entry must use the intended transport");
  for (const framework of frameworks) await frameworkUI(page, framework);
  await nextAPI(page);
  const asset = await page.evaluate(async () => {
    const response = await fetch("../probe.txt");
    return { status: response.status, body: await response.text() };
  });
  assert.deepEqual(asset, { status: 200, body: "framework asset\n" });
  assert.ok(responses.some(response => response.url.includes("/_next/") && response.status === 200), "Next assets loaded");
  assert.ok(responses.some(response => response.url.includes("_rsc=") && response.status === 200), "Next RSC navigation/refresh ran");
  assert.deepEqual(errors, [], "hydration/page errors");
  return responses;
}

async function frameworkUI(page: Page, framework: string) {
  if (framework !== "express") await page.getByRole("link", { name: framework, exact: true }).click();
  await page.getByRole("heading", { name: framework, exact: true }).waitFor();
  await page.getByRole("button", { name: "Client clicks: 0", exact: true }).click();
  await page.getByRole("button", { name: "Client clicks: 1", exact: true }).waitFor();
  const initial = await page.getByTestId("server-items").textContent();
  assert.ok(!initial?.includes(`ui-${framework}`), `${framework} state starts independently`);
  await page.getByRole("textbox", { name: "Note" }).fill(`ui-${framework}`);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "POST 201" }).waitFor();
  await page.getByTestId("server-items").filter({ hasText: `ui-${framework}` }).waitFor();
  await frameworkHTTP(page, framework);
  await page.reload();
  await page.getByTestId("server-items").filter({ hasText: `ui-${framework}` }).waitFor();
}

async function frameworkHTTP(page: Page, framework: string) {
  const observed = await page.evaluate(async framework => {
    const path = `../api/${framework}/items`;
    const read = await fetch(`${path}?q=preview%20query`);
    const body: unknown = await read.json();
    const denied = await fetch(path, { headers: { "x-deny": "1" } });
    const invalid = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const missing = await fetch(`../api/${framework}/missing`);
    const stream = framework === "express" ? await (await fetch("../api/express/stream")).text() : null;
    return { status: read.status, header: read.headers.get("x-framework"), body, denied: denied.status, invalid: invalid.status, missing: missing.status, stream };
  }, framework);
  assert.equal(observed.status, 200);
  assert.equal(observed.header, framework);
  assert.equal(observed.denied, 403);
  assert.equal(observed.invalid, 400);
  assert.equal(observed.missing, 404);
  const body = observed.body;
  assert.ok(body && typeof body === "object" && "items" in body && "query" in body);
  assert.equal(body.query, "preview query");
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.includes(`ui-${framework}`));
  for (const other of frameworks.filter(other => other !== framework)) assert.ok(!body.items.includes(`ui-${other}`), "framework state leaked");
  if (framework === "express") assert.ok(observed.stream?.includes("ui-express"), "streaming rewrite body");
}

async function nextAPI(page: Page) {
  const observed = await page.evaluate(async () => {
    const posted = await fetch("../api/next", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ui-next" }) });
    const body: unknown = await posted.json();
    const get = await fetch("../api/next?q=next%20query");
    const invalid = await fetch("../api/next", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return { status: posted.status, header: posted.headers.get("x-framework"), body, get: await get.json(), invalid: invalid.status };
  });
  assert.equal(observed.status, 201);
  assert.equal(observed.header, "next");
  assert.equal(observed.invalid, 400);
  assert.ok(observed.body && typeof observed.body === "object" && "items" in observed.body && Array.isArray(observed.body.items));
  assert.ok(observed.body.items.includes("ui-next"));
  assert.deepEqual(observed.get, { items: observed.body.items, query: "next query" });
}
