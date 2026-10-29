import assert from "node:assert/strict";
import type { Page } from "playwright";

export const routeCases = ["static", "dynamic", "get-post", "suspense", "stream-cancel", "action", "redirect", "missing", "application-error", "client", "overlap"] as const;
export type RouteCase = typeof routeCases[number];

async function navigate(page: Page, base: string, path: string, status = 200) {
  const response = await page.goto(new URL(path.replace(/^\//, ""), base).href);
  assert.equal(response?.status(), status, `${path} public URL HTTP status`);
  return response;
}

export async function overlappingRequests(page: Page, base: string, marker: string) {
  await navigate(page, base, "");
  const results = await page.evaluate(async ({ base, marker }) => {
    const request = async (index: number) => {
      const value = `${marker}-${index}`;
      document.cookie = `next-marker-${value}=${value}; path=/`;
      const path = index % 2 === 0 ? "dynamic" : "api/context?fail=1";
      const response = await fetch(new URL(path, base), { headers: { "x-next-marker": value } });
      return { marker: value, status: response.status, text: await response.text() };
    };
    return Promise.all(Array.from({ length: 6 }, (_, index) => request(index)));
  }, { base, marker });
  await page.evaluate(marker => {
    for (let index = 0; index < 6; index++) document.cookie = `next-marker-${marker}-${index}=; max-age=0; path=/`;
  }, marker);
  for (const result of results) verifyContext(result, result.marker);
}

function verifyContext(response: { status: number; text: string }, marker: string) {
  assert.equal(response.status, 200, response.text.slice(0, 500));
  const normalized = response.text.replaceAll("&quot;", '"');
  for (const field of ["header", "cookie", "after", "cookieAfter"]) assert.ok(normalized.includes(`"${field}":"${marker}"`), `${field} lost after await: ${normalized.slice(0, 1000)}`);
}

export async function runRouteCase(name: RouteCase, page: Page, base: string) {
  if (name === "overlap") return overlappingRequests(page, base, `overlap-${Date.now()}`);
  if (name === "get-post") return getPost(page, base);
  if (name === "stream-cancel") return stream(page, base);
  if (name === "static") { await navigate(page, base, ""); await page.getByRole("heading", { name: "NEXT-01 static", exact: true }).waitFor(); return; }
  if (name === "dynamic") { await navigate(page, base, "dynamic"); await page.locator("[data-context]").waitFor(); return; }
  if (name === "suspense") {
    const response = await navigate(page, base, "stream");
    const body = await response!.text();
    assert.ok(body.includes("NEXT-01 fallback") && body.includes("NEXT-01 deferred"), "Suspense shell and deferred payload");
    await page.getByText("NEXT-01 deferred", { exact: true }).waitFor(); return;
  }
  if (name === "action") {
    await navigate(page, base, "action");
    await page.locator('[data-hydrated="true"]').waitFor();
    await page.getByRole("button", { name: "Submit action", exact: true }).click();
    await page.locator("[data-action-result]").filter({ hasText: "NEXT-01 action:submitted" }).waitFor(); return;
  }
  if (name === "redirect") { await navigate(page, base, "redirect"); assert.ok(new URL(page.url()).pathname.endsWith("/dynamic")); return; }
  if (name === "missing") { await navigate(page, base, "missing-acceptance", 404); await page.getByRole("heading", { name: "NEXT-01 missing", exact: true }).waitFor(); return; }
  if (name === "application-error") {
    await navigate(page, base, "error", 500);
    await page.getByRole("heading", { name: "NEXT-01 application error", exact: true }).waitFor();
    await navigate(page, base, ""); await page.getByRole("heading", { name: "NEXT-01 static", exact: true }).waitFor(); return;
  }
  await navigate(page, base, "");
  await page.locator('[data-hydrated="true"]').waitFor();
  await page.getByRole("button", { name: "Count: 0", exact: true }).click();
  await page.getByRole("button", { name: "Count: 1", exact: true }).waitFor();
}

async function getPost(page: Page, base: string) {
  await navigate(page, base, "");
  const result = await page.evaluate(async base => {
    const get = await fetch(new URL("api/context", base));
    const post = await fetch(new URL("api/context", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "NEXT-01 posted" }) });
    return { get: get.status, post: post.status, body: await post.json() };
  }, base);
  assert.equal(result.get, 200); assert.equal(result.post, 201);
  assert.deepEqual(result.body.body, { value: "NEXT-01 posted" });
}

async function stream(page: Page, base: string) {
  await navigate(page, base, "");
  const result = await page.evaluate(async base => {
    const read = async (cancel: boolean) => {
      const response = await fetch(new URL("api/stream", base));
      const reader = response.body!.getReader();
      const start = performance.now();
      const first = await reader.read();
      const firstMs = performance.now() - start;
      const early = new TextDecoder().decode(first.value);
      if (cancel) await reader.cancel();
      if (cancel) return { early, late: "", firstMs, gapMs: 0 };
      const last = await reader.read();
      return { early, late: new TextDecoder().decode(last.value), firstMs, gapMs: performance.now() - start - firstMs };
    };
    return { complete: await read(false), cancelled: await read(true), after: (await fetch(new URL("api/context", base))).status };
  }, base);
  assert.equal(result.complete.early, "NEXT-01 early\n");
  assert.equal(result.complete.late, "NEXT-01 late\n");
  assert.ok(result.complete.gapMs >= 200, "stream chunks arrived together");
  assert.equal(result.cancelled.early, "NEXT-01 early\n");
  assert.equal(result.after, 200, "server recovered after cancellation");
}
