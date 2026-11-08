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

for (const command of ["dev", "start"]) {
  test(`SolidStart ${command} accepts exactly one allocated port`, async () => {
    const template: unknown = await Bun.file(new URL("../sandbox/template-solidstart/package.json", import.meta.url)).json();
    if (!template || typeof template !== "object" || !("scripts" in template)) throw new Error("Missing template scripts");
    const scripts = template.scripts;
    if (!scripts || typeof scripts !== "object" || !(command in scripts)) throw new Error(`Missing ${command} script`);
    const script: unknown = Reflect.get(scripts, command);
    if (typeof script !== "string") throw new Error(`Invalid ${command} script`);
    const combined = `${script} --port 41821`;
    expect(combined.match(/--port\b/g)).toHaveLength(1);
    expect(combined).toContain("--port 41821");
  });
}
