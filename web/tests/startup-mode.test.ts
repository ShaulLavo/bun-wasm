import { expect, test } from "bun:test";

const transpiler = new Bun.Transpiler({ loader: "ts" });
for (const app of ["web", "sandbox"]) {
  test(`${app} reports a typed construction failure before filesystem creation`, async () => {
    const source = await Bun.file(new URL(app === "web" ? "../src/main.ts" : "../../sandbox/src/main.ts", import.meta.url)).text();
    const outer = source.slice(source.indexOf("void main().catch("));
    const startup = (await Bun.file(new URL("../src/startup.ts", import.meta.url)).text()).replace(/^export /gm, "");
    const status = { textContent: "", dataset: { kind: "" } };
    const button = { textContent: "", disabled: true };
    const error = Object.assign(new Error("Unsupported VFS mode: safe"), { name: "VfsError", code: "UNSUPPORTED_VFS", vfs: "safe" });
    const document = { querySelector: (selector: string) => selector === "#status" ? status : selector === (app === "web" ? "#run" : "#restart") ? button : { disabled: false }, querySelectorAll: () => [] };
    const run = new Function("main", "document", "console", "location", `${transpiler.transformSync(startup)}\n${transpiler.transformSync(outer)}; return new Promise(resolve => setTimeout(resolve, 0));`);
    await run(() => Promise.reject(error), document, { error() {} }, { reload() {} });
    expect(status.textContent).toContain("UNSUPPORTED_VFS");
    expect(status.textContent).toContain("safe");
    expect(status.dataset.kind).toBe("error");
    expect(button.disabled).toBe(false);
  });
}
