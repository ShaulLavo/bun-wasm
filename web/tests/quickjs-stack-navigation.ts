import type { Page } from "playwright";
import { openPlaygroundPage } from "./playground-navigation";

export async function openQuickjsStackPage(page: Page, url: string): Promise<void> {
  await openPlaygroundPage(page, `${url}?engine=quickjs&prompt=off&mode=memory`, {
    readyTimeout: 90_000,
    diagnostic: {
      prefix: "quickjs-stack-navigation", title: "QuickJS stack navigation",
      fields: { budget: process.env.QUICKJS_STACK_KIB ?? "default" },
    },
  });
}
