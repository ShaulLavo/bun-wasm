import { test } from "bun:test";
import { withBrowserGuestRegression } from "./browser-guest-wrapper";
import { executeExistingBrowserDriver } from "./browser-existing-drivers";

test("selected browser guest installer links", () => withBrowserGuestRegression({ owner: "installer-links", controls: () => [],
  execute: context => executeExistingBrowserDriver("installer-links", context) }), 3_120_000);
