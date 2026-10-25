import { productMarker, type ProductApp, type ProductCommand } from "./product-types.ts";

function serverCheck(framework: string, validationStatus = 400): ProductCommand["check"] {
  return {
    kind: "http",
    text: productMarker,
    probes: [
      { kind: "response", id: "middleware", path: "/", status: 200, text: productMarker, header: { name: "x-product-framework", value: framework } },
      { kind: "response", id: "params-query", path: "/items/42?tag=matrix", status: 200, text: '{"id":"42","tag":"matrix"}' },
      { kind: "response", id: "changed-input", path: "/items/7?tag=changed", status: 200, text: '{"id":"7","tag":"changed"}' },
      { kind: "response", id: "reject-param", path: "/items/not-a-number?tag=matrix", status: validationStatus },
      { kind: "response", id: "reject-query", path: "/items/42", status: validationStatus },
      { kind: "response", id: "not-found", path: "/not-a-route", status: 404 },
    ],
  };
}

function serverApp(id: string, version: string, source: string, dependencies: Record<string, string> = {}): ProductApp {
  return {
    id,
    family: "server",
    dependencies: { [id]: version, ...dependencies },
    files: { "server.ts": source },
    commands: [{ name: "start", args: ["run", "server.ts"], check: serverCheck(id, id === "elysia" ? 422 : 400) }],
    features: ["run:typescript-entrypoint", "http:middleware", "http:path-and-query", "reject:invalid-param", "reject:missing-query", "reject:unknown-route", "build:not-applicable:direct-typescript-entry-no-build-toolchain"],
  };
}

const hono = `import { Hono } from 'hono';
const app = new Hono();
app.use('*', async (c, next) => {
  await next();
  c.header('x-product-framework', 'hono');
});
app.get('/', c => c.text('${productMarker}'));
app.get('/items/:id', c => {
  const id = c.req.param('id');
  const tag = c.req.query('tag');
  if (!/^\\d+$/.test(id) || !tag) return c.json({ error: 'invalid item' }, 400);
  return c.json({ id, tag });
});
Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT ?? '3137'), fetch: app.fetch });
`;

const express = `import express from 'express';
const app = express();
app.use((_req, res, next) => { res.set('x-product-framework', 'express'); next(); });
app.get('/', (_req, res) => res.send('${productMarker}'));
app.get('/items/:id', (req, res) => {
  const id = req.params.id;
  const tag = req.query.tag;
  if (!/^\\d+$/.test(id) || typeof tag !== 'string' || !tag) return res.status(400).json({ error: 'invalid item' });
  return res.json({ id, tag });
});
app.listen(Number(process.env.PORT ?? '3137'), '127.0.0.1');
`;

const fastify = `import Fastify from 'fastify';
const app = Fastify();
app.addHook('onRequest', async (_req, reply) => { reply.header('x-product-framework', 'fastify'); });
app.get('/', async () => '${productMarker}');
app.get<{ Params: { id: string }; Querystring: { tag: string } }>('/items/:id', {
  schema: {
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9]+$' } } },
    querystring: { type: 'object', required: ['tag'], properties: { tag: { type: 'string', minLength: 1 } } },
  },
}, async req => ({ id: req.params.id, tag: req.query.tag }));
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? '3137') });
`;

const koa = `import Koa from 'koa';
import Router from '@koa/router';
const app = new Koa();
const router = new Router();
app.use(async (ctx, next) => { ctx.set('x-product-framework', 'koa'); await next(); });
router.get('/', ctx => { ctx.body = '${productMarker}'; });
router.get('/items/:id', ctx => {
  const id = ctx.params.id;
  const tag = ctx.query.tag;
  if (!/^\\d+$/.test(id) || typeof tag !== 'string' || !tag) { ctx.status = 400; ctx.body = { error: 'invalid item' }; return; }
  ctx.body = { id, tag };
});
app.use(router.routes());
app.use(router.allowedMethods());
app.listen(Number(process.env.PORT ?? '3137'), '127.0.0.1');
`;

const elysia = `import { Elysia, t } from 'elysia';
new Elysia()
  .onRequest(({ set }) => { set.headers['x-product-framework'] = 'elysia'; })
  .get('/', () => '${productMarker}')
  .get('/items/:id', ({ params, query }) => ({ id: params.id, tag: query.tag }), {
    params: t.Object({ id: t.String({ pattern: '^[0-9]+$' }) }),
    query: t.Object({ tag: t.String({ minLength: 1 }) }),
  })
  .listen({ hostname: '127.0.0.1', port: Number(process.env.PORT ?? '3137') });
`;

const nestSource = `import 'reflect-metadata';
import { BadRequestException, Controller, Get, Header, Module, Param, ParseIntPipe, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Controller()
class ProductController {
  @Get()
  @Header('x-product-framework', 'nestjs')
  index(): string { return '${productMarker}'; }

  @Get('items/:id')
  item(@Param('id', ParseIntPipe) id: number, @Query('tag') tag?: string): { id: string; tag: string } {
    if (!tag) throw new BadRequestException('tag is required');
    return { id: String(id), tag };
  }
}

@Module({ controllers: [ProductController] })
class ProductModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ProductModule);
  await app.listen(Number(process.env.PORT ?? '3137'), '127.0.0.1');
}
void bootstrap();
`;

export const serverApps: ProductApp[] = [
  serverApp("hono", "4.10.2", hono),
  serverApp("express", "5.1.0", express),
  serverApp("fastify", "5.6.1", fastify),
  serverApp("koa", "3.0.1", koa, { "@koa/router": "14.0.0" }),
  serverApp("elysia", "1.4.13", elysia, { "@sinclair/typebox": "0.34.41", "file-type": "21.0.0", "exact-mirror": "0.2.2", "openapi-types": "12.1.3" }),
  {
    id: "nestjs",
    family: "server",
    dependencies: { "@nestjs/common": "11.1.7", "@nestjs/core": "11.1.7", "@nestjs/platform-express": "11.1.7", "@nestjs/cli": "11.0.10", "reflect-metadata": "0.2.2", rxjs: "7.8.2", typescript: "5.9.3", "@types/node": "22.18.10" },
    files: {
      "src/main.ts": nestSource,
      "nest-cli.json": JSON.stringify({ sourceRoot: "src", compilerOptions: { deleteOutDir: true } }, null, 2),
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", outDir: "dist", rootDir: "src", experimentalDecorators: true, emitDecoratorMetadata: true, strict: true, skipLibCheck: true }, include: ["src/**/*.ts"] }, null, 2),
    },
    commands: [
      { name: "dev", args: ["run", "src/main.ts"], check: serverCheck("nestjs") },
      { name: "build", args: ["run", "node_modules/@nestjs/cli/bin/nest.js", "build"], check: { kind: "files", paths: ["dist/main.js"], text: productMarker } },
      { name: "start", after: "build", args: ["run", "dist/main.js"], check: serverCheck("nestjs") },
    ],
    features: ["run:typescript-decorators", "http:controller-and-header-decorator", "http:path-and-query", "reject:parse-int-pipe", "reject:missing-query", "reject:unknown-route", "build:nest-cli-tsc", "start:emitted-controller"],
  },
];
