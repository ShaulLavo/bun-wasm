import { test } from "bun:test";
import { withBrowserGuestRegression } from "./browser-guest-wrapper";
import { executeExistingBrowserDriver } from "./browser-existing-drivers";

test("selected browser guest subprocess aliases and continuations", () => withBrowserGuestRegression({ owner: "subprocess", controls: () => [],
  execute: context => executeExistingBrowserDriver("subprocess", context) }), 3_120_000);
