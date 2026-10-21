import type { Framework } from "./names";

export const entryPort = 43100;
export const ports = {
  express: 43101, koa: 43102, fastify: 43103, hono: 43104, elysia: 43105,
} satisfies Record<Framework, number>;

export function backendURL(framework: Framework, path: string): string {
  return `http://127.0.0.1:${ports[framework]}${path}`;
}
