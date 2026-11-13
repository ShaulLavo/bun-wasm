import type { Page } from "playwright";
import { ready } from "./playground.mjs";

export async function openQuickjsStackPage(page: Page, url: string): Promise<void> {
  // Runtime publication below decides readiness; unrelated resources need not finish loading.
  await page.goto(`${url}?engine=quickjs&prompt=off&mode=memory`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await ready(page, 90_000);
}
