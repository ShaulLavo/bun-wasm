import { expect, test } from "bun:test";
import { frameworks } from "./catalog";

test("TanStack Start hydrates at its server root on the selected free port", () => {
  const framework = frameworks.find(item => item.id === "tanstack-start");
  expect(framework?.rootPreview).toEqual({
    dev: "bun run dev --port {port}",
    start: "PORT={port} bun run start",
  });
});
