import { observeHmr } from "./hmr";
import { featureObservations, type Observation, type ProductPage } from "./product-browser";
import type { ProductCheck } from "./product-types";

type NativePage = Pick<ProductPage, "goto" | "locator"> & Parameters<typeof observeHmr>[0];
type PageCheck = Omit<Extract<ProductCheck, { kind: "page" }>, "kind">;

export async function checkNativePage(page: NativePage, url: string, check: PageCheck, project: string, timeout: number, capture: () => Promise<void>) {
  const verifyHmr = observeHmr(page);
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  await page.goto(url, { timeout: remaining() });
  await page.locator(check.selector).filter({ hasText: check.text }).waitFor({ timeout: remaining() });
  const hmr = check.hmr && await verifyHmr(project, check.selector, check.hmr, remaining(), capture);
  const observations: Observation[] = hmr ? [{ stage: "hmr", status: "pass", assertion: hmr }] : [];
  return {
    status: "pass",
    assertion: `${check.selector} renders ${JSON.stringify(check.text)}${hmr ? `; ${hmr}` : ""}`,
    observations: observations.concat(await featureObservations(page, url, check.probes ?? [], remaining())),
  };
}
