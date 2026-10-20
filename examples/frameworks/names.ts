export const frameworks = ["express", "koa", "fastify", "hono", "elysia"] as const;
export type Framework = typeof frameworks[number];
export function isFramework(value: string): value is Framework {
  return frameworks.some(name => name === value);
}
