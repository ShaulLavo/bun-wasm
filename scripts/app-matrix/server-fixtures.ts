const serverMarker = "bun-wasm app matrix";

const sources = {
  hono: `import { Hono } from 'hono';
const app = new Hono();
app.use('*', async (c, next) => {
  await next();
  c.header('x-matrix-framework', 'hono');
  c.header('x-matrix-token', c.req.header('x-matrix-token') ?? '');
});
app.get('/', c => c.text('${serverMarker}'));
app.get('/items/:id', c => c.json({ framework: 'hono', id: c.req.param('id'), tag: c.req.query('tag') }));
app.post('/items/:id', async c => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON' }, 400); }
  return c.json({ framework: 'hono', id: c.req.param('id'), value: body.value, count: body.count }, 201);
});
Bun.serve({ port: Number(process.env.PORT ?? '3137'), fetch: app.fetch });`,
  express: `import express from 'express';
const app = express();
app.use((req, res, next) => {
  res.set('x-matrix-framework', 'express');
  res.set('x-matrix-token', req.get('x-matrix-token') ?? '');
  next();
});
app.use(express.json());
app.get('/', (req, res) => res.send('${serverMarker}'));
app.get('/items/:id', (req, res) => res.json({ framework: 'express', id: req.params.id, tag: req.query.tag }));
app.post('/items/:id', (req, res) => res.status(201).json({ framework: 'express', id: req.params.id, value: req.body.value, count: req.body.count }));
app.listen(Number(process.env.PORT ?? '3137'), '127.0.0.1');`,
  elysia: `import { Elysia } from 'elysia';
new Elysia()
  .onRequest(({ request, set }) => {
    set.headers['x-matrix-framework'] = 'elysia';
    set.headers['x-matrix-token'] = request.headers.get('x-matrix-token') ?? '';
  })
  .get('/', () => '${serverMarker}')
  .get('/items/:id', ({ params, query }) => ({ framework: 'elysia', id: params.id, tag: query.tag }))
  .post('/items/:id', ({ params, body, set }) => {
    set.status = 201;
    return { framework: 'elysia', id: params.id, value: body.value, count: body.count };
  })
  .listen(Number(process.env.PORT ?? '3137'));`,
  fastify: `import Fastify from 'fastify';
const app = Fastify();
app.addHook('onRequest', async (req, reply) => {
  reply.header('x-matrix-framework', 'fastify');
  reply.header('x-matrix-token', req.headers['x-matrix-token'] ?? '');
});
app.get('/', async () => '${serverMarker}');
app.get('/items/:id', async req => ({ framework: 'fastify', id: req.params.id, tag: req.query.tag }));
app.post('/items/:id', async (req, reply) => {
  reply.code(201);
  return { framework: 'fastify', id: req.params.id, value: req.body.value, count: req.body.count };
});
await app.listen({ port: Number(process.env.PORT ?? '3137'), host: '127.0.0.1' });`,
  koa: `import Koa from 'koa';
const app = new Koa();
app.use(async (ctx, next) => {
  ctx.set('x-matrix-framework', 'koa');
  ctx.set('x-matrix-token', ctx.get('x-matrix-token'));
  await next();
});
async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk.toString();
  return JSON.parse(text);
}
app.use(async ctx => {
  if (ctx.method === 'GET' && ctx.path === '/') { ctx.body = '${serverMarker}'; return; }
  const match = /^\\/items\\/([^/]+)$/.exec(ctx.path);
  if (!match) return;
  const id = decodeURIComponent(match[1]);
  if (ctx.method === 'GET') { ctx.body = { framework: 'koa', id, tag: ctx.query.tag }; return; }
  if (ctx.method !== 'POST') return;
  let body;
  try { body = await readJson(ctx.req); } catch {
    ctx.status = 400;
    ctx.body = { error: 'invalid JSON' };
    return;
  }
  ctx.status = 201;
  ctx.body = { framework: 'koa', id, value: body.value, count: body.count };
});
app.listen(Number(process.env.PORT ?? '3137'), '127.0.0.1');`,
};

function server(id: keyof typeof sources, version: string) {
  return {
    id, dependencies: { [id]: version }, files: { "server.ts": sources[id] },
    commands: [{ name: "start", args: ["run", "server.ts"], check: { kind: "http", text: serverMarker, framework: id } }],
  };
}

export const serverApps = [
  server("hono", "4.10.2"), server("express", "5.1.0"), server("elysia", "1.4.13"),
  server("fastify", "5.6.1"), server("koa", "3.0.1"),
];
export const serverIds = serverApps.map(app => app.id);
