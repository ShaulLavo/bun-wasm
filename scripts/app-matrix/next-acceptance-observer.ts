import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { phaseSenderControl } from "./next-acceptance-phase-coverage";

const fixture = join(import.meta.dir, "fixtures/browser-error-phase-observer");
export const observerHooks = ["handle-request-base", "handle-request-dev", "find-page-components-dev", "find-page-components-parent", "ensure-page", "error-render", "error-render-base", "render-components", "send-render-result", "http-request", "http-writeHead", "http-flushHeaders", "http-write", "http-end"];

export function applyBrowserErrorPhaseObserver(files: Record<string, string>) {
  const route = files["app/api/context/route.ts"];
  const config = files["next.config.mjs"];
  assert.ok(route && config, "Missing staged context route or ESM config for phase observer");
  const get = 'return Response.json(await context(new URL(request.url).searchParams.has("fail")));';
  const post = 'return Response.json({ ...await context(true), body }, { status: 201 });';
  assert.equal(route.split(get).length, 2, "Context GET source changed; refuse observer adaptation");
  assert.equal(route.split(post).length, 2, "Context POST source changed; refuse observer adaptation");
  const paths = ["instrumentation.ts", "server-observer-call.ts", "server-observer-state.ts", "server-observer-runtime.ts"];
  for (const name of paths) files[name] = readFileSync(join(fixture, name), "utf8");
  files[phaseSenderControl.path] = phaseSenderControl.source;
  files["next.config.mjs"] = `${config}\nconfig.webpack = webpackConfig => { const externals = webpackConfig.externals; webpackConfig.externals = Array.isArray(externals) ? externals.concat("node:http") : externals ? [externals, "node:http"] : ["node:http"]; return webpackConfig; };\n`;
  files["app/api/context/route.ts"] = 'import { observerSnapshot } from "../../../server-observer-state";\n' + route
    .replace(get, 'return Response.json({ ...await context(new URL(request.url).searchParams.has("fail")), observer: observerSnapshot() });')
    .replace(post, 'return Response.json({ ...await context(true), body, observer: observerSnapshot() }, { status: 201 });');
  return paths.concat([phaseSenderControl.path, "next.config.mjs", "app/api/context/route.ts"]).map(path => ({
    path, sha256: createHash("sha256").update(files[path] ?? "").digest("hex"),
  }));
}

function object(value: unknown, name: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `Missing observer ${name}`);
  return Object.fromEntries(Object.entries(value));
}

export function requireServingObserver(body: string): void {
  const observed = object(JSON.parse(body), "response");
  assert.ok(typeof observed.pid === "number" && Number.isSafeInteger(observed.pid) && observed.pid > 0, "Invalid serving process identity");
  const observer = object(observed.observer, "acknowledgement");
  assert.equal(observer.servingContext, true, "Observer must run in the Next serving worker");
  assert.equal(observer.registered, true, "Observer register() must run");
  assert.equal(observer.dropped, 0, "Observer records must not be dropped");
  const registration = object(observer.registration, "registration");
  assert.equal(registration.nextWorker, true);
  assert.equal(registration.runtime, "nodejs");
  assert.equal(registration.pid, observed.pid, "Acknowledgement must identify this serving process");
  assert.equal(registration.moduleCacheAccess, true);
  assert.equal(registration.provider, "module.createRequire");
  const modules: unknown = registration.modules;
  assert.ok(Array.isArray(modules), "Missing cached Next modules");
  const expectedModules: [string, string, string][] = [
    ["base-server", "/next/dist/server/base-server.js", "BaseServer"],
    ["next-server", "/next/dist/server/next-server.js", "NextNodeServer"],
    ["next-dev-server", "/next/dist/server/dev/next-dev-server.js", "DevServer"],
  ];
  for (const [label, suffix, constructor] of expectedModules) verifyCachedModule(modules, label, suffix, constructor);
  const hooks: unknown = registration.hooks;
  assert.ok(Array.isArray(hooks), "Missing installed observer hooks");
  const installedHooks = hooks.map(value => object(value, "hook"));
  for (const target of observerHooks) {
    const hook: Record<string, unknown> | undefined = installedHooks.find(value => value.target === target);
    assert.ok(hook && Array.isArray(hook.installed) && hook.installed.includes(target), `Missing installed hook ${target}`);
  }
}

function verifyCachedModule(modules: unknown[], label: string, suffix: string, constructor: string): void {
  const module = modules.map(value => object(value, "cached module")).find(value => value.label === label);
  assert.ok(module, `Missing cached module ${label}`);
  assert.ok(typeof module.path === "string" && module.path.endsWith(suffix), `Unexpected cached path ${label}`);
  assert.equal(module.defaultConstructor, constructor);
}
