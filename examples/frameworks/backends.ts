import { createServer } from "node:http";
import express from "express";
import Koa from "koa";
import Fastify from "fastify";
import { Hono } from "hono";
import { Elysia } from "elysia";
import { ports } from "./ports.server";
import { listen, closeServer, type lifetime } from "./lifetime";

export function textBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("text" in body)) return;
  if (typeof body.text !== "string" || !body.text.trim()) return;
  return body.text.trim();
}

type Scope = ReturnType<typeof lifetime>;

async function startExpress(scope: Scope) {
  const items: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader("x-framework", "express");
    if (req.headers["x-deny"] === "1") { res.status(403).json({ error: "denied" }); return; }
    next();
  });
  app.get("/items", (req, res) => { res.json({ items, query: req.query.q ?? null }); });
  app.post("/items", (req, res) => {
    const text = textBody(req.body);
    if (!text) { res.status(400).json({ error: "text required" }); return; }
    items.push(text);
    res.status(201).json({ items });
  });
  app.get("/stream", (_req, res) => {
    res.type("text/plain");
    res.write(`items:${items.length}\n`);
    res.end(JSON.stringify(items));
  });
  const server = createServer(app);
  scope.own(() => closeServer(server));
  await listen(server, ports.express);
}

async function readJSON(request: Koa.Request["req"]): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return JSON.parse(body);
}

async function startKoa(scope: Scope) {
  const items: string[] = [];
  const app = new Koa();
  app.use(async (ctx, next) => {
    ctx.set("x-framework", "koa");
    if (ctx.get("x-deny") === "1") { ctx.status = 403; ctx.body = { error: "denied" }; return; }
    await next();
  });
  app.use(async ctx => {
    if (ctx.path !== "/items") return;
    if (ctx.method === "GET") { ctx.body = { items, query: ctx.query.q ?? null }; return; }
    if (ctx.method !== "POST") return;
    const body = await readJSON(ctx.req).catch(() => null);
    const text = textBody(body);
    if (!text) { ctx.status = 400; ctx.body = { error: "text required" }; return; }
    items.push(text);
    ctx.status = 201;
    ctx.body = { items };
  });
  const server = createServer(app.callback());
  scope.own(() => closeServer(server));
  await listen(server, ports.koa);
}

async function startFastify(scope: Scope) {
  const items: string[] = [];
  const app = Fastify();
  scope.own(() => app.close());
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-framework", "fastify");
    if (request.headers["x-deny"] === "1") return reply.code(403).send({ error: "denied" });
  });
  app.get<{ Querystring: { q?: string } }>("/items", async request => ({ items, query: request.query.q ?? null }));
  app.post("/items", async (request, reply) => {
    const text = textBody(request.body);
    if (!text) return reply.code(400).send({ error: "text required" });
    items.push(text);
    return reply.code(201).send({ items });
  });
  await app.listen({ port: ports.fastify, host: "127.0.0.1" });
}

function startHono(scope: Scope) {
  const items: string[] = [];
  const app = new Hono();
  app.use("*", async (ctx, next) => {
    ctx.header("x-framework", "hono");
    if (ctx.req.header("x-deny") === "1") return ctx.json({ error: "denied" }, 403);
    await next();
  });
  app.get("/items", ctx => ctx.json({ items, query: ctx.req.query("q") ?? null }));
  app.post("/items", async ctx => {
    const body: unknown = await ctx.req.json().catch(() => null);
    const text = textBody(body);
    if (!text) return ctx.json({ error: "text required" }, 400);
    items.push(text);
    return ctx.json({ items }, 201);
  });
  const server = Bun.serve({ port: ports.hono, hostname: "127.0.0.1", fetch: app.fetch });
  scope.own(async () => { await server.stop(true); });
}

function startElysia(scope: Scope) {
  const items: string[] = [];
  const app = new Elysia()
    .onRequest(({ request, set }) => {
      set.headers["x-framework"] = "elysia";
      if (request.headers.get("x-deny") === "1") { set.status = 403; return { error: "denied" }; }
    })
    .get("/items", ({ query }) => ({ items, query: query.q ?? null }))
    .post("/items", ({ body, set }) => {
      const text = textBody(body);
      if (!text) { set.status = 400; return { error: "text required" }; }
      items.push(text);
      set.status = 201;
      return { items };
    })
    .listen({ port: ports.elysia, hostname: "127.0.0.1" });
  scope.own(async () => { await app.stop(true); });
}

export async function startBackends(scope: Scope) {
  await startExpress(scope);
  await startKoa(scope);
  await startFastify(scope);
  startHono(scope);
  startElysia(scope);
}
