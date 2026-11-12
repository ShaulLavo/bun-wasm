import { test, expect } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";

function element(type: string | (() => unknown), props: Record<string, unknown> | null, ...children: unknown[]): unknown {
  if (typeof type === "function") return type();
  return { type, props, children };
}
function button(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || !("type" in value) || !("props" in value) || !("children" in value)) throw new Error("Expected JSX element");
  if (value.type === "button" && value.props && typeof value.props === "object") return value.props as Record<string, unknown>;
  if (!Array.isArray(value.children)) throw new Error("Missing JSX children");
  for (const child of value.children) { try { return button(child); } catch {} }
  throw new Error("No button in component");
}
function hooks() {
  const values: unknown[] = [], effects: (() => void)[] = [];
  let cursor = 0;
  return {
    reset() { cursor = 0; },
    effects,
    useEffect(effect: () => void) { effects.push(effect); },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], (update: unknown) => { values[index] = typeof update === "function" ? update(values[index]) : update; }];
    },
  };
}
for (const file of ["template-next/pages/index.tsx", "template-next-app/app/page.tsx", "template-react-router/app/routes/home.tsx"]) {
  test(`${file} disables the SSR counter until its hydration effect runs`, async () => {
    const state = hooks();
    const source = (await Bun.file(join(import.meta.dir, "../../sandbox", file)).text()).replace(/^import .*;$/gm, "").replaceAll("export default ", "").replaceAll("export ", "");
    const javascript = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "element" } } }).transformSync(source + "\nglobalThis.render = Home;");
    const context = createContext({ useState: state.useState, useEffect: state.useEffect, useLoaderData: () => ({ value: "fixture" }), element });
    runInContext(javascript, context);
    const first: unknown = runInContext("render()", context);
    expect(button(first).disabled).toBe(true);
    for (const effect of state.effects.splice(0)) effect();
    state.reset();
    const hydrated: unknown = runInContext("render()", context);
    expect(button(hydrated).disabled).toBe(false);
    const click = button(hydrated).onClick;
    if (typeof click !== "function") throw new Error("Missing counter handler");
    click(); state.reset();
    expect(JSON.stringify(runInContext("render()", context))).toContain("1");
  });
}

test("static counter scripts enable their initially disabled buttons only after installing handlers", async () => {
  for (const file of ["template-astro/src/pages/index.astro", "template-hono/src/page.html"]) {
    const html = await Bun.file(join(import.meta.dir, "../../sandbox", file)).text();
    expect(html).toMatch(/<button[^>]*disabled/);
  }
  const source = await Bun.file(join(import.meta.dir, "../../sandbox/template-hono/counter.ts")).text();
  let listener: (() => void) | undefined;
  const target = { disabled: true, addEventListener(_event: string, handler: () => void) { listener = handler; } };
  const output = { value: "0" };
  const context = createContext({ document: { querySelector: (selector: string) => selector === "#increment" ? target : output } });
  runInContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source), context);
  expect(target.disabled).toBe(false);
  if (!listener) throw new Error("Counter listener missing");
  listener(); expect(output.value).toBe("1");
});

test("SolidStart's SSR button waits for its client mount", async () => {
  const values: unknown[] = [], effects: (() => void)[] = [];
  let cursor = 0;
  const source = (await Bun.file(join(import.meta.dir, "../../sandbox/template-solidstart/src/routes/index.tsx")).text()).replace(/^import .*;$/gm, "").replace("export default ", "");
  const javascript = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "element" } } }).transformSync(source + "\nglobalThis.render = Home;");
  const context = createContext({
    createSignal(initial: unknown) { const index = cursor++; if (!(index in values)) values[index] = initial; return [() => values[index], (value: unknown) => { values[index] = value; }]; },
    URLSearchParams, onMount: (effect: () => void) => effects.push(effect), useLocation: () => ({ search: "" }),
    element,
  });
  runInContext(javascript, context);
  expect(button(runInContext("render()", context)).disabled).toBe(true);
  for (const effect of effects.splice(0)) effect();
  cursor = 0;
  expect(button(runInContext("render()", context)).disabled).toBe(false);
});

test("Nuxt's SSR button waits for its mounted ref", async () => {
  const source = await Bun.file(join(import.meta.dir, "../../sandbox/template-nuxt/app.vue")).text();
  expect(source).toContain(':disabled="!hydrated"');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Nuxt setup script missing");
  const effects: (() => void)[] = [];
  const context = createContext({ ref: (value: unknown) => ({ value }), onMounted: (effect: () => void) => effects.push(effect), useRoute: () => ({ query: {} }), useFetch: async () => ({ data: { value: "fixture" } }) });
  const result: unknown = await runInContext(`(async () => { ${script}; return hydrated; })()`, context);
  if (!result || typeof result !== "object" || !("value" in result)) throw new Error("Mounted ref missing");
  expect(result.value).toBe(false);
  for (const effect of effects) effect();
  expect(result.value).toBe(true);
});
