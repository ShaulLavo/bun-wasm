import { test } from "bun:test";
import { ownedScenario } from "./fixtures/deadline-scenario";

test("command deadline removes a real stopped detached Chromium and preserves unrelated processes", () => ownedScenario("browser"), 15000);
