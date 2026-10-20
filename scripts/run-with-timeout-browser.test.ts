import { test } from "bun:test";
import { ownedScenario } from "./fixtures/deadline-scenario";

test("command deadline removes a real stopped detached Chromium and preserves unrelated processes", () => ownedScenario("browser"), 15000);

test("abrupt launcher failure removes a real stopped detached Chromium and preserves exit 137", () => ownedScenario("failed-browser"), 15000);

test("Bun abrupt launcher failure removes a real stopped detached Chromium and preserves exit 137", () => ownedScenario("failed-browser", "bun"), 15000);

test("SIGTERM removes a real stopped detached Chromium and preserves exit 143", () => ownedScenario("browser", "node", "SIGTERM"), 15000);

test("Bun SIGINT removes a real stopped detached Chromium and preserves exit 130", () => ownedScenario("browser", "bun", "SIGINT"), 15000);
