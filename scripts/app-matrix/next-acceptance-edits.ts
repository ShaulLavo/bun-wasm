import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { GuestSource, ProductTraffic } from "./product-browser";

export const edits = [
  { path: "app/client.tsx", route: "", original: "client-original", updated: "client-edited", selector: "[data-client-edit]" },
  { path: "app/dynamic/page.tsx", route: "dynamic", original: "server-original", updated: "server-edited", selector: "h1" },
  { path: "app/globals.css", route: "", original: "rgb(12, 34, 56)", updated: "rgb(65, 43, 21)", selector: ".edit-color" },
];

export async function editCycle(page: Page, base: string, source: GuestSource, traffic: ProductTraffic, index: number, timeout: number, sample: (phase: string) => Promise<void>) {
  const edit = edits[index % edits.length];
  assert.ok(edit);
  const original = await source.read(edit.path);
  assert.ok(original);
  assert.ok(original.includes(edit.original), `Source marker ${edit.path}`);
  await page.goto(new URL(edit.route, base).href);
  await page.locator(edit.selector).waitFor();
  await traffic.beginEdit();
  const before = await traffic.count();
  try {
    await source.write(edit.path, original.replace(edit.original, edit.updated));
    await verifyEdit(page, edit.selector, edit.updated, timeout);
    assert.ok((await traffic.evidenceSince(before)).some(event => event.framework === "next"), "No Next HMR message after edit");
    await sample(`cycle:${index}:edited`);
    await page.reload();
    await verifyEdit(page, edit.selector, edit.updated, timeout);
  } finally { await source.write(edit.path, original); }
  await verifyEdit(page, edit.selector, edit.original, timeout);
  await page.reload();
  await verifyEdit(page, edit.selector, edit.original, timeout);
}

async function verifyEdit(page: Page, selector: string, value: string, timeout: number) {
  if (selector !== ".edit-color") { await page.locator(selector).filter({ hasText: value }).waitFor({ timeout }); return; }
  await page.waitForFunction(({ selector, value }) => {
    const element = document.querySelector(selector);
    return element && getComputedStyle(element).color === value;
  }, { selector, value }, { timeout });
}

export async function compileErrorRecovery(page: Page, base: string, source: GuestSource) {
  const path = "app/dynamic/page.tsx";
  const original = await source.read(path);
  assert.ok(original);
  try {
    await source.write(path, original + "\nexport const broken = ;\n");
    await page.waitForFunction(async url => {
      const response = await fetch(url);
      const body = await response.text();
      return response.status === 500 && /broken|Unexpected token|Parsing ecmascript/i.test(body);
    }, new URL("dynamic", base).href, { timeout: 60000 });
  } finally { await source.write(path, original); }
  await page.goto(new URL("dynamic", base).href);
  await page.getByRole("heading", { name: "server-original", exact: true }).waitFor();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("heading", { name: "NEXT-01 static", exact: true }).waitFor();
}
