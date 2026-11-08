import { expect, test } from "bun:test";
import { frameworks } from "./goals-matrix/catalog";
import { playgroundURL } from "./goals-matrix/run";

test("SolidStart acceptance keeps the browser router at the server's root path", () => {
  const framework = frameworks.find(item => item.id === "solidstart");
  if (!framework) throw new Error("Missing SolidStart template");
  const url = new URL(playgroundURL("http://127.0.0.1:4173/", framework, "browser"));
  expect(url.searchParams.has("root-previews")).toBe(true);
  expect(url.searchParams.get("template")).toBe("solidstart");
  expect(url.searchParams.get("engine")).toBe("browser");
  expect(url.searchParams.get("mode")).toBe("memory");
  expect(framework.rootPreview?.dev.replaceAll("{port}", "41821")).toBe("bun run dev --port 41821");
  expect(framework.rootPreview?.start.replaceAll("{port}", "41821")).toBe("bun run start --port 41821");
});
