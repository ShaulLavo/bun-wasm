import { test } from "bun:test";
import { withBrowserGuestRegression } from "./browser-guest-wrapper";
import { executeExistingBrowserDriver } from "./browser-existing-drivers";

test("selected browser guest preview WebSocket headers and full networking", () => withBrowserGuestRegression({ owner: "preview-websocket", controls: () => [],
  execute: context => executeExistingBrowserDriver("preview-websocket", context) }), 3_120_000);
