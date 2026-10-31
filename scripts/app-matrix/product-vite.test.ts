import { expect, test } from "bun:test";
import { productMarker } from "./product-types.ts";
import { viteApps } from "./product-vite.ts";

const plugins: Record<string, string> = {
  "vite-react": "@vitejs/plugin-react",
  "vite-vue": "@vitejs/plugin-vue",
  "vite-svelte": "@sveltejs/vite-plugin-svelte",
  "vite-solid": "vite-plugin-solid",
  "vite-preact": "@preact/preset-vite",
};

test("six distinct Vite projects use pinned packages and the real component plugins", () => {
  expect(viteApps.map(app => app.id)).toEqual(["vite-vanilla", "vite-react", "vite-vue", "vite-svelte", "vite-solid", "vite-preact"]);
  for (const app of viteApps) {
    expect(app.dependencies.vite).toBe("7.1.12");
    expect(Object.values(app.dependencies).every(version => /^\d+\.\d+\.\d+$/.test(version))).toBe(true);
    const plugin = plugins[app.id];
    if (!plugin) continue;
    expect(app.dependencies[plugin]).toBeDefined();
    expect(app.files["vite.config.ts"]).toContain(`from '${plugin}'`);
  }
});

test.each(viteApps)("$id has dev HMR, emitted JS checks, and built preview interaction", app => {
  expect(app.commands.map(command => command.name)).toEqual(["dev", "build", "preview"]);
  const dev = app.commands.find(command => command.name === "dev");
  const build = app.commands.find(command => command.name === "build");
  const preview = app.commands.find(command => command.name === "preview");
  if (dev?.check.kind !== "page" || !dev.check.hmr || build?.check.kind !== "files" || preview?.check.kind !== "page") throw new Error(`Missing Vite lifecycle for ${app.id}`);
  expect(dev.args).toContain("node_modules/vite/bin/vite.js");
  expect(dev.args).toContain("--strictPort");
  const edit = dev.check.hmr;
  const source = app.files[edit.path];
  if (!source) throw new Error(`Missing HMR source ${edit.path}`);
  expect(source.split(edit.search)).toHaveLength(2);
  expect(edit.replacement).not.toBe(edit.search);
  expect(source.replace(edit.search, edit.replacement)).toContain(edit.replacement);
  expect(build.check.paths).toEqual(["dist/index.html", "dist/assets/app.js"]);
  expect(build.check.text).toBe(productMarker);
  expect(app.files["vite.config.ts"]).toContain("entryFileNames: 'assets/app.js'");
  expect(preview.after).toBe("build");
  expect(preview.args).toContain("preview");
  expect(preview.check.selector).toBe("#message");
  expect(dev.check.probes).toContainEqual({ kind: "action", id: "counter", path: "/", button: "#increment", selector: "#count", text: "Count: 1" });
  expect(preview.check.probes).toEqual(dev.check.probes);
  expect(source).toContain('id="increment"');
  expect(source).toContain('id="count"');
  expect(app.files["index.html"]).not.toContain('id="message"');
});

test.each(viteApps)("$id authors TypeScript entrypoints instead of handwritten JavaScript", app => {
  const html = app.files["index.html"];
  expect(html).toMatch(/src="\/src\/main\.tsx?"/);
  expect(Object.keys(app.files).some(path => /\.[cm]?jsx?$/.test(path))).toBe(false);
  for (const [path, source] of Object.entries(app.files)) {
    if (!/\.tsx?$/.test(path)) continue;
    expect(() => new Bun.Transpiler({ loader: path.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(source)).not.toThrow();
  }
});
