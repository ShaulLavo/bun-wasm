import { callerSourceOrigin } from "bun:jsc";

export function helper() {
  return { origin: callerSourceOrigin() };
}

export async function afterAwait() {
  await Promise.resolve();
  return { origin: callerSourceOrigin() };
}

export function later() {
  return new Promise((resolve) => setTimeout(() => resolve({ origin: callerSourceOrigin() }), 0));
}
