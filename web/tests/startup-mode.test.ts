import { afterEach, expect, spyOn, test } from "bun:test";
import { models } from "./ui-model-helpers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

for (const app of ["web", "sandbox"] as const) {
  test(`${app} reports a typed construction failure before filesystem creation`, async () => {
    const page = await models();
    cleanups.push(page.cleanup);
    const construction = spyOn(page.boundary, "createRuntime");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = app === "web"
        ? playgroundView(page)
        : sandboxView(page);
      const { model } = view;
      await model.start();
      expect(construction).not.toHaveBeenCalled();
      expect(model.status.text).toContain("UNSUPPORTED_VFS");
      expect(model.status.text).toContain("safe");
      expect(model.status.kind).toBe("error");
      const markup = await view.render();
      expect(markup).toContain('data-kind="error"');
      expect(markup).toContain("UNSUPPORTED_VFS");
      expect(markup).toContain("safe");
      const button = markup.match(new RegExp(`<button[^>]*id="${app === "web" ? "run" : "restart"}"[^>]*>`))?.[0];
      expect(button).toBeDefined();
      expect(button).not.toContain("disabled");
      expect(markup).toContain(">Reload</button>");
    } finally { errors.mockRestore(); construction.mockRestore(); }
  });
}

function playgroundView(page: Awaited<ReturnType<typeof models>>) {
  const model = new page.Playground("?mode=safe");
  return { model, render: () => page.renderPlayground(model) };
}

function sandboxView(page: Awaited<ReturnType<typeof models>>) {
  const model = new page.Sandbox("?mode=safe");
  return { model, render: () => page.renderSandbox(model) };
}
