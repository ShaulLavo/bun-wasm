import { test } from "bun:test";
import { withBrowserGuestRegression } from "./browser-guest-wrapper";
import { executeExistingBrowserDriver } from "./browser-existing-drivers";

test("selected browser guest tools integrity and persistent cache continuations", () => withBrowserGuestRegression({ owner: "tools-integrity", controls: () => [],
  execute: context => executeExistingBrowserDriver("tools-integrity", context) }), 3_120_000);
