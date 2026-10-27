import { expect, test } from "bun:test";
import { productMarker } from "./product-types.ts";
import { serverApps } from "./product-servers.ts";

function server(id: string) {
  const app = serverApps.find(app => app.id === id);
  if (!app) throw new Error(`Missing product server ${id}`);
  return app;
}

test("six server fixtures pin real frameworks and keep their HTTP entrypoints", () => {
  expect(serverApps.map(app => app.id)).toEqual(["hono", "express", "fastify", "koa", "elysia", "nestjs"]);
  for (const app of serverApps) {
    expect(Object.values(app.dependencies).every(version => /^\d+\.\d+\.\d+$/.test(version))).toBe(true);
    expect(app.commands.some(command => command.check.kind === "http")).toBe(true);
    expect(Object.keys(app.files).some(path => /\.[cm]?jsx?$/.test(path) || path.startsWith("node_modules/"))).toBe(false);
  }
  expect(server("hono").files["server.ts"]).toContain("fetch: app.fetch");
  expect(server("express").files["server.ts"]).toContain("import express from 'express'");
  expect(server("fastify").files["server.ts"]).toContain("await app.listen(");
  expect(server("koa").files["server.ts"]).toContain("app.use(router.routes())");
  expect(server("elysia").files["server.ts"]).toContain("new Elysia()");
  expect(server("nestjs").files["src/main.ts"]).toContain("NestFactory.create(ProductModule)");
});

test.each(serverApps)("$id probes changing path/query input, headers, invalid requests, and 404", app => {
  for (const command of app.commands) {
    if (command.check.kind !== "http") continue;
    const probes = command.check.probes;
    expect(command.check.text).toBe(productMarker);
    expect(probes?.find(probe => probe.id === "middleware")).toMatchObject({ kind: "response", status: 200, header: { name: "x-product-framework", value: app.id } });
    expect(probes?.find(probe => probe.id === "params-query")).toMatchObject({ kind: "response", path: "/items/42?tag=matrix", text: '{"id":"42","tag":"matrix"}' });
    expect(probes?.find(probe => probe.id === "changed-input")).toMatchObject({ kind: "response", path: "/items/7?tag=changed", text: '{"id":"7","tag":"changed"}' });
    expect(probes?.find(probe => probe.id === "reject-param")).toMatchObject({ kind: "response", status: app.id === "elysia" ? 422 : 400 });
    expect(probes?.find(probe => probe.id === "reject-query")).toMatchObject({ kind: "response", status: app.id === "elysia" ? 422 : 400 });
    expect(probes?.find(probe => probe.id === "not-found")).toMatchObject({ kind: "response", status: 404 });
  }
});

test("direct TypeScript servers say build is N/A rather than inventing a bundler stage", () => {
  for (const app of serverApps.filter(app => app.id !== "nestjs")) {
    expect(app.commands.map(command => command.name)).toEqual(["start"]);
    expect(app.commands[0]?.args).toEqual(["run", "server.ts"]);
    expect(app.features).toContain("build:not-applicable:direct-typescript-entry-no-build-toolchain");
  }
});

test("Nest has a real CLI build with decorator metadata and starts its emitted controller", () => {
  const app = server("nestjs");
  expect(app.dependencies["@nestjs/platform-express"]).toBe("11.1.7");
  expect(app.commands.map(command => command.name)).toEqual(["dev", "build", "start"]);
  expect(app.commands.find(command => command.name === "build")?.args).toEqual(["run", "node_modules/@nestjs/cli/bin/nest.js", "build"]);
  expect(app.commands.find(command => command.name === "build")?.check).toMatchObject({ kind: "files", paths: ["dist/main.js"], text: productMarker });
  expect(app.commands.find(command => command.name === "start")).toMatchObject({ after: "build", args: ["run", "dist/main.js"] });
  expect(JSON.parse(app.files["tsconfig.json"] ?? "null")).toMatchObject({ compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true, module: "NodeNext" } });
  expect(app.files["src/main.ts"]).toContain("@Param('id', ParseIntPipe)");
});

test("validation belongs to real server routing, with Koa router and Elysia peers installed", () => {
  expect(server("koa").dependencies["@koa/router"]).toBe("14.0.0");
  expect(server("fastify").files["server.ts"]).toContain("querystring:");
  expect(server("elysia").files["server.ts"]).toContain("query: t.Object(");
  expect(server("elysia").dependencies["@sinclair/typebox"]).toBe("0.34.41");
  expect(server("elysia").dependencies["file-type"]).toBe("21.0.0");
});

test.each(serverApps)("$id TypeScript entrypoints have valid syntax and use the assigned port", app => {
  for (const [path, source] of Object.entries(app.files)) {
    if (!path.endsWith(".ts")) continue;
    expect(source).toContain("process.env.PORT");
    expect(() => new Bun.Transpiler({ loader: "ts", tsconfig: JSON.stringify({ compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } }) }).transformSync(source)).not.toThrow();
  }
});
