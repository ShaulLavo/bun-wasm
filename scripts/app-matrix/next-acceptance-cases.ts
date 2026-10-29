import assert from "node:assert/strict";
import type { Page } from "playwright";
import { requestProbe } from "./next-acceptance-http";

export const routeCases = ["static", "dynamic", "get-post", "suspense", "stream-cancel", "action", "redirect", "missing", "application-error", "client", "overlap"] as const;
export type RouteCase = typeof routeCases[number];

async function navigate(page: Page, base: string, path: string, status = 200) {
  const response = await page.goto(new URL(path.replace(/^\//, ""), base).href);
  assert.equal(response?.status(), status, `${path} public URL HTTP status`);
  return response;
}

export async function overlappingRequests(page: Page, base: string, marker: string, timeout = 60000) {
  const deadline = Date.now() + timeout;
  await navigate(page, base, "");
  const markers = Array.from({ length: 6 }, (_, index) => `${marker}-${index}`);
  await page.evaluate(markers => {
    for (const value of markers) document.cookie = `next-marker-${value}=${value}; path=/`;
  }, markers);
  const requests = markers.map(async (value, index) => {
    const post = index % 3 === 2;
    const path = index % 3 === 0 ? "dynamic" : "api/context?fail=1";
    const response = await requestProbe(page, { url: new URL(path, base).href, deadline,
      method: post ? "POST" : "GET", headers: { "x-next-marker": value, "content-type": "application/json" },
      body: post ? JSON.stringify({ marker: value }) : null, expectedStatus: post ? 201 : 200 });
    return { marker: value, status: response.status, expectedStatus: post ? 201 : 200, text: response.body };
  });
  try {
    const results = await Promise.all(requests);
    for (const result of results) verifyContext(result, result.marker);
  } finally {
    await Promise.allSettled(requests);
    await page.evaluate(markers => {
      for (const value of markers) document.cookie = `next-marker-${value}=; max-age=0; path=/`;
    }, markers);
  }
}

function verifyContext(response: { status: number; expectedStatus: number; text: string }, marker: string) {
  assert.equal(response.status, response.expectedStatus, response.text.slice(0, 500));
  const normalized = response.text.replaceAll("&quot;", '"');
  for (const field of ["header", "cookie", "after", "cookieAfter"]) assert.ok(normalized.includes(`"${field}":"${marker}"`), `${field} lost after await: ${normalized.slice(0, 1000)}`);
}

export async function runRouteCase(name: RouteCase, page: Page, base: string, timeout = 60000) {
  if (name === "overlap") return overlappingRequests(page, base, `overlap-${Date.now()}`, timeout);
  if (name === "get-post") return getPost(page, base, timeout);
  if (name === "stream-cancel") return stream(page, base, timeout);
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

async function getPost(page: Page, base: string, timeout: number) {
  const deadline = Date.now() + timeout;
  await navigate(page, base, "");
  await requestProbe(page, { url: new URL("api/context", base).href, deadline });
  const post = await requestProbe(page, { url: new URL("api/context", base).href, deadline,
    method: "POST", expectedStatus: 201, headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "NEXT-01 posted" }) });
  const result: unknown = JSON.parse(post.body);
  assert.ok(result && typeof result === "object" && "body" in result);
  assert.deepEqual(result.body, { value: "NEXT-01 posted" });
}

async function stream(page: Page, base: string, timeout: number) {
  const deadline = Date.now() + timeout;
  await navigate(page, base, "");
  const complete = await requestProbe(page, { url: new URL("api/stream", base).href, deadline });
  assert.equal(complete.kind, "complete", "Stream must reach EOF");
  assert.equal(complete.body, "NEXT-01 early\nNEXT-01 late\n");
  assert.equal(complete.chunks[0]?.text, "NEXT-01 early\n");
  const first = complete.chunks[0];
  const last = complete.chunks.at(-1);
  assert.ok(first && last && last.timeMs - first.timeMs >= 200, "stream chunks arrived together");
  const cancelled = await requestProbe(page, { url: new URL("api/stream", base).href, deadline, mode: "cancel-after-first" });
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.body, "NEXT-01 early\n");
  await requestProbe(page, { url: new URL("api/context", base).href, deadline });
}
