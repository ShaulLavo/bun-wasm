import { expect, test } from "bun:test";
import { nextApps } from "./product-next";
import { productMarker } from "./product-types";

const exactVersion = /^\d+\.\d+\.\d+$/;
const versioned = new Map<string, Record<string, string>>([
  ["16", { next: "16.4.3", react: "19.2.0", "react-dom": "19.2.0", typescript: "5.9.3", "@types/node": "22.18.10", "@types/react": "19.2.2", "@types/react-dom": "19.2.2" }],
  ["15", { next: "15.5.6", react: "19.2.0", "react-dom": "19.2.0", typescript: "5.9.3", "@types/node": "22.18.10", "@types/react": "19.2.2", "@types/react-dom": "19.2.2" }],
  ["14", { next: "14.2.33", "@next/swc-wasm-nodejs": "14.2.33", react: "18.3.1", "react-dom": "18.3.1", typescript: "5.9.3", "@types/node": "22.18.10", "@types/react": "18.3.12", "@types/react-dom": "18.3.1" }],
]);

function command(app: (typeof nextApps)[number], name: string) {
  const found = app.commands.find(candidate => candidate.name === name);
  if (!found) throw new Error(`${app.id} is missing ${name}`);
  return found;
}

function feature(app: (typeof nextApps)[number], prefix: string): string {
  const found = app.features?.find(value => value.startsWith(prefix));
  if (!found) throw new Error(`${app.id} is missing ${prefix}`);
  return found;
}

test("Next catalog exports stable current and older major coverage", () => {
  expect(nextApps).toHaveLength(14);
  expect(new Set(nextApps.map(app => app.id)).size).toBe(nextApps.length);
  for (const app of nextApps) {
    expect(app.id).toMatch(/^next-(14|15|16)-(app|pages)(-static|-ppr(-experimental)?)?$/);
    expect(app.family).toBe("next");
    expect(Object.values(app.dependencies).every(value => exactVersion.test(value))).toBe(true);
    expect(Object.values(app.files).some(value => value.includes(productMarker))).toBe(true);
    expect(command(app, "dev").args).toContain("node_modules/next/dist/bin/next");
    expect(command(app, "build").after).toBeUndefined();
    expect(["start", "preview"].some(name => app.commands.some(candidate => candidate.name === name))).toBe(true);
  }
});

test("every Next major uses the registry-verified React pairing", () => {
  for (const [major, expected] of versioned) {
    const apps = nextApps.filter(app => app.id.startsWith(`next-${major}-`));
    expect(apps.length).toBe(major === "14" ? 4 : 5);
    for (const app of apps) expect(app.dependencies).toEqual(app.id.endsWith("-static") ? { ...expected, "@types/bun": "1.4.3" } : expected);
  }
});

test("Next 14 declares and opts into its official WASM compiler", () => {
  for (const app of nextApps) {
    const isNext14 = app.id.startsWith("next-14-");
    const config = app.files["next.config.mjs"] ?? app.files["next.config.ts"] ?? "";
    expect(config.includes("useWasmBinary: true")).toBe(isNext14);
    if (isNext14) expect(app.dependencies["@next/swc-wasm-nodejs"]).toBe("14.2.33");
  }
});

test("dynamic routers have real dev HMR, build, production and feature probes", () => {
  for (const app of nextApps.filter(candidate => !candidate.id.includes("static"))) {
    const dev = command(app, "dev");
    const build = command(app, "build");
    const production = command(app, "start");
    expect(dev.check.kind).toBe("page");
    if (dev.check.kind === "page") expect(dev.check.hmr?.search).toBe(dev.check.text);
    expect(build.check).toMatchObject({ kind: "files", paths: [".next/BUILD_ID"] });
    expect(production.after).toBe("build");
    expect(production.check.kind).toBe("page");
    expect(feature(app, "ssr:")).not.toContain("n/a");
    expect(feature(app, "middleware:")).not.toContain("n/a");
    const probes = dev.check.kind === "page" ? dev.check.probes ?? [] : [];
    if (app.id.includes("-app")) {
      expect(probes.some(probe => probe.id === "app-ssr-response")).toBe(true);
    }
    expect(probes.some(probe => probe.id === "middleware-response")).toBe(true);
  }
});

test("Next 16 uses the current proxy entrypoint while older majors keep middleware", () => {
  for (const app of nextApps.filter(candidate => !candidate.id.includes("static"))) {
    const usesProxy = app.id.startsWith("next-16-");
    expect(Boolean(app.files[usesProxy ? "proxy.ts" : "middleware.ts"])).toBe(true);
    expect(Boolean(app.files[usesProxy ? "middleware.ts" : "proxy.ts"])).toBe(false);
    expect(feature(app, "middleware:")).toContain(usesProxy ? "proxy" : "response");
  }
});

test("app router action probes use the matching React action API", () => {
  for (const app of nextApps.filter(candidate => candidate.id.endsWith("-app"))) {
    const action = feature(app, "server-actions:");
    const hasProbe = app.commands.some(commandSpec => commandSpec.check.kind === "page" && commandSpec.check.probes?.some(probe => probe.kind === "action"));
    expect(action).toContain("action-probe");
    expect(hasProbe).toBe(true);
    if (app.id.startsWith("next-14-")) expect(app.files["app/action/action-form.tsx"]).toContain("useFormState");
    if (!app.id.startsWith("next-14-")) expect(app.files["app/action/action-form.tsx"]).toContain("useActionState");
  }
});

test("pages fixtures retain ISR source without claiming an unimplemented cache oracle", () => {
  for (const app of nextApps.filter(candidate => /-pages$/.test(candidate.id))) {
    expect(app.files["pages/isr.tsx"]).toContain("revalidate: 1");
    expect(feature(app, "isr:")).toBe("isr:pending-cache-sequence-probe");
    const check = command(app, "dev").check;
    const probes = check.kind === "page" ? check.probes ?? [] : [];
    expect(probes.some(probe => probe.id.includes("isr"))).toBe(false);
  }
});

test("static export fixtures build out/ and preview the generated artifact", () => {
  for (const app of nextApps.filter(candidate => candidate.id.includes("static"))) {
    expect(app.dependencies["@types/bun"]).toBe("1.4.3");
    const build = command(app, "build");
    const preview = command(app, "preview");
    expect(build.check).toMatchObject({ kind: "files", paths: ["out/index.html"] });
    expect(preview.after).toBe("build");
    expect(preview.check.kind).toBe("page");
    expect(feature(app, "mode:static-export")).toBe("mode:static-export");
    expect(feature(app, "mode:static-preview")).toBe("mode:static-preview");
    if (app.id.startsWith("next-14-")) {
      expect(app.files["next.config.mjs"]).toContain('output: "export"');
      expect(app.files["next.config.ts"]).toBeUndefined();
      continue;
    }
    expect(app.files["next.config.ts"]).toContain('output: "export"');
    expect(app.files["next.config.mjs"]).toBeUndefined();
  }
});

test("PPR fixtures use real delayed Suspense data with version-specific config", () => {
  const pprApps = nextApps.filter(app => app.id.includes("-app-ppr"));
  expect(pprApps).toHaveLength(2);
  for (const app of pprApps) {
    const fixture = app.files["app/ppr/page.tsx"];
    expect(fixture).toContain("Suspense");
    expect(fixture).toContain('import { connection } from "next/server"');
    expect(fixture).toContain("await connection()");
    expect(fixture).toContain("setTimeout(resolve, 100)");
    expect(fixture).toContain("data-ppr-shell");
    expect(fixture).toContain("data-ppr-deferred");
    expect(feature(app, "ppr:")).toContain("pending");
    if (app.id.startsWith("next-16-")) {
      expect(app.files["next.config.ts"]).toContain("cacheComponents: true");
      expect(app.files["app/api/ssr/route.ts"]).not.toContain('export const dynamic = "force-dynamic"');
      expect(fixture).not.toContain("experimental_ppr");
      continue;
    }
    expect(app.files["next.config.ts"]).toContain("experimental: { ppr: true }");
    expect(fixture).toContain("experimental_ppr = true");
  }
});

test("ISR fixture exposes a generation value for a real cache-window sequence", () => {
  for (const app of nextApps.filter(candidate => candidate.id.endsWith("-pages"))) {
    const fixture = app.files["pages/isr.tsx"];
    expect(fixture).toContain("Date.now().toString()");
    expect(fixture).toContain("data-isr-generation");
    expect(fixture).toContain("revalidate: 1");
    expect(feature(app, "isr:")).toBe("isr:pending-cache-sequence-probe");
  }
});

test("Next 14 server actions use default support alongside WASM compiler config", () => {
  const app = nextApps.find(candidate => candidate.id === "next-14-app");
  if (!app) throw new Error("next-14-app is missing");
  expect(app.files["next.config.mjs"]).toContain("useWasmBinary: true");
  expect(app.files["next.config.ts"]).toBeUndefined();
  expect(app.files["app/action/action-form.tsx"]).toContain("useFormState");
  expect(app.files["app/action/action-form.tsx"]).toContain("useFormStatus");
  expect(app.files["app/action/action-form.tsx"]).not.toContain("experimental.serverActions");
});

test("ISR and PPR metadata stays explicit about pending or N/A verification", () => {
  for (const app of nextApps) {
    expect(feature(app, "isr:")).toMatch(/(pending|n\/a)/);
    expect(feature(app, "ppr:")).toMatch(/(pending|n\/a|experimental-available)/);
  }
});


test("only Next 16 dev and build select the official WASM-supported Webpack path", () => {
  for (const app of nextApps) {
    const bundler = app.id.startsWith("next-16-") ? ["--webpack"] : [];
    expect(command(app, "dev").args).toEqual(
      ["run", "node_modules/next/dist/bin/next", "dev"].concat(bundler, ["--hostname", "127.0.0.1", "--port", "{port}"]),
    );
    expect(command(app, "build").args).toEqual(
      ["run", "node_modules/next/dist/bin/next", "build"].concat(bundler),
    );
    const production = app.id.includes("static") ? "preview" : "start";
    const expected = production === "preview"
      ? ["run", "preview.ts"]
      : ["run", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "{port}"];
    expect(command(app, production).args).toEqual(expected);
  }
});
