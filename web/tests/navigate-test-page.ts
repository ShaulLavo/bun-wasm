import type { Page, Route } from "playwright";

export type NavigationPage = Pick<Page, "goto" | "route" | "unroute"> & {
  context(): { browser(): { browserType(): { name(): string } } | null };
};

/**
 * `page.goto` for test pages. Use it for every http(s) navigation that can run in WebKit.
 *
 * WebKit bug 325840: a cross-origin-isolated (COOP) response can overtake the old web process's load-start
 * IPC, and WebKit then cancels its own process-swapped navigation. Playwright misses that cancellation, so
 * goto waits on about:blank until its timeout. A one-use pass-through route makes Playwright intercept the
 * document request, which admits that IPC before the real request continues. Same workaround as Waffle's
 * tests/browser-navigation.ts, except for `times`. Remove when Playwright ships https://github.com/WebKit/WebKit/pull/75569.
 *
 * No `times: 1`: in Playwright 1.64.1, an expiring page route that falls back to a context route turns page
 * interception off while the context handler runs, so that handler's `route.continue()` rejects with
 * "Route is already handled!". The exact-URL matcher and the removal below bound the route instead.
 */
export async function navigateTestPage(page: NavigationPage, target: string, options?: Parameters<Page["goto"]>[1]): ReturnType<Page["goto"]> {
  if (page.context().browser()?.browserType().name() !== "webkit" || !/^https?:/.test(target)) return page.goto(target, options);
  const url = new URL(target);
  url.hash = "";
  const matches = (candidate: URL) => candidate.href === url.href;
  const resume = (route: Route) => route.fallback();
  await page.route(matches, resume);
  try {
    return await page.goto(target, options);
  } finally {
    await page.unroute(matches, resume).catch(() => {});
  }
}
