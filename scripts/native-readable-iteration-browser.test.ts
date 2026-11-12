import { test } from "bun:test";

test("missing native stream iteration works through the browser state bridge", async () => {
  await import("../web/tests/browser-native-readable-iteration");
}, 60_000);
