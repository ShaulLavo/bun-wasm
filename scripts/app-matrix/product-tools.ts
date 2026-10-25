import { productMarker, type ProductApp } from "./product-types.ts";

const prismaSchema = `generator client {
  provider = "prisma-client-js"
}
datasource db {
  provider = "sqlite"
  url = "file:./product.db"
}
model Message {
  id Int @id @default(autoincrement())
  key String @unique
  value String
}
`;

const drizzleOpen = `import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { messages } from './schema';
const sqlite = new Database('product.db');
const db = drizzle(sqlite);
`;

export const toolApps: ProductApp[] = [
  {
    id: "vitest",
    family: "tool",
    dependencies: { vitest: "3.2.4", vite: "7.1.12" },
    files: {
      "src/cart.ts": `export function total(prices: readonly number[]): number {
  if (prices.some(price => price < 0)) throw new RangeError('negative price');
  return prices.reduce((sum, price) => sum + price, 0);
}
`,
      "tests/cart.test.ts": `import { expect, test } from 'vitest';
import { total } from '../src/cart';
test('adds item prices', () => expect(total([3, 4, 5])).toBe(12));
test('rejects negative prices', () => expect(() => total([2, -1])).toThrow('negative price'));
`,
      "controls/failure.test.ts": `import { expect, test } from 'vitest';
import { total } from '../src/cart';
test('product rejection control', () => expect(total([2, 3])).toBe(99));
`,
    },
    commands: [
      { name: "test", args: ["run", "node_modules/vitest/vitest.mjs", "run", "tests/cart.test.ts", "--maxWorkers=1", "--no-file-parallelism"], check: { kind: "stdout", text: "2 passed" } },
      { name: "threads", args: ["run", "node_modules/vitest/vitest.mjs", "run", "tests/cart.test.ts", "--pool=threads", "--maxWorkers=1", "--no-file-parallelism"], check: { kind: "stdout", text: "2 passed" } },
      { name: "reject", args: ["run", "node_modules/vitest/vitest.mjs", "run", "controls/failure.test.ts", "--maxWorkers=1", "--no-file-parallelism"], check: { kind: "diagnostics", exit: 1, texts: ["product rejection control", "AssertionError", "1 failed"] } },
    ],
    features: ["test:module-import", "test:assertions", "test:forks", "test:threads", "reject:intentionally-failing-test", "build:not-applicable:test-runner"],
  },
  {
    id: "prisma",
    family: "tool",
    dependencies: { prisma: "6.17.1", "@prisma/client": "6.17.1" },
    files: {
      "prisma/schema.prisma": prismaSchema,
      "controls/invalid.prisma": `datasource db {
  provider = "sqlite"
  url = "file:./invalid.db"
}
model MissingId {
  value String
}
`,
      "query.ts": `import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
try {
  await db.message.upsert({ where: { key: 'positive' }, create: { key: 'positive', value: 'before' }, update: { value: 'before' } });
  await db.message.update({ where: { key: 'positive' }, data: { value: '${productMarker}' } });
  const message = await db.message.findUnique({ where: { key: 'positive' } });
  if (message?.value !== '${productMarker}') throw new Error('Prisma query mismatch');
  console.log('${productMarker}: prisma query');
} finally {
  await db.$disconnect();
}
`,
      "reject.ts": `import { Prisma, PrismaClient } from '@prisma/client';
const db = new PrismaClient();
try {
  await db.message.upsert({ where: { key: 'duplicate' }, create: { key: 'duplicate', value: 'first' }, update: { value: 'first' } });
  let rejected = false;
  try {
    await db.message.create({ data: { key: 'duplicate', value: 'second' } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    rejected = true;
  }
  if (!rejected) throw new Error('Prisma accepted a duplicate unique key');
  const count = await db.message.count({ where: { key: 'duplicate' } });
  if (count !== 1) throw new Error('Rejected Prisma write changed the database');
  console.log('${productMarker}: prisma unique rejection');
} finally {
  await db.$disconnect();
}
`,
    },
    commands: [
      { name: "validate", args: ["run", "node_modules/prisma/build/index.js", "validate", "--schema", "prisma/schema.prisma"], check: { kind: "stdout", text: "is valid" } },
      { name: "reject-schema", args: ["run", "node_modules/prisma/build/index.js", "validate", "--schema", "controls/invalid.prisma"], check: { kind: "diagnostics", exit: 1, texts: ["P1012", "at least one unique criteria"] } },
      { name: "generate", args: ["run", "node_modules/prisma/build/index.js", "generate", "--schema", "prisma/schema.prisma"], check: { kind: "files", paths: ["node_modules/.prisma/client/index.js", "node_modules/.prisma/client/schema.prisma"], text: "Message" } },
      { name: "schema", after: "generate", args: ["run", "node_modules/prisma/build/index.js", "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], check: { kind: "files", paths: ["prisma/product.db"], text: "" } },
      { name: "query", after: "schema", args: ["run", "query.ts"], check: { kind: "stdout", text: `${productMarker}: prisma query` } },
      { name: "reject", after: "schema", args: ["run", "reject.ts"], check: { kind: "stdout", text: `${productMarker}: prisma unique rejection` } },
    ],
    features: ["schema:sqlite-file", "generate:real-prisma-client", "query:create-update-read", "reject:schema-without-id", "reject:database-unique-constraint", "build:not-applicable:client-generation-is-generate-stage", "limit:native-prisma-engines-required-no-substitute"],
  },
  {
    id: "drizzle",
    family: "tool",
    dependencies: { "drizzle-orm": "0.44.6", "drizzle-kit": "0.31.5" },
    files: {
      "schema.ts": `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
});
`,
      "drizzle.config.ts": `import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'sqlite', schema: './schema.ts', out: './drizzle' });
`,
      "migrate.ts": `${drizzleOpen}import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
try {
  migrate(db, { migrationsFolder: './drizzle' });
  const table = sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
  if (!table) throw new Error('Drizzle migration did not create the table');
  console.log('${productMarker}: drizzle schema');
} finally {
  sqlite.close();
}
`,
      "query.ts": `${drizzleOpen}import { eq } from 'drizzle-orm';
try {
  db.insert(messages).values({ key: 'positive', value: 'before' }).onConflictDoUpdate({ target: messages.key, set: { value: 'before' } }).run();
  db.update(messages).set({ value: '${productMarker}' }).where(eq(messages.key, 'positive')).run();
  const row = db.select().from(messages).where(eq(messages.key, 'positive')).get();
  if (row?.value !== '${productMarker}') throw new Error('Drizzle query mismatch');
  console.log('${productMarker}: drizzle query');
} finally {
  sqlite.close();
}
`,
      "reject.ts": `${drizzleOpen}import { eq } from 'drizzle-orm';
try {
  db.insert(messages).values({ key: 'duplicate', value: 'first' }).onConflictDoNothing().run();
  let rejected = false;
  try {
    db.insert(messages).values({ key: 'duplicate', value: 'second' }).run();
  } catch (error) {
    const cause = error instanceof Error && 'cause' in error ? error.cause : error;
    if (!(cause instanceof Error) || !/UNIQUE constraint failed/.test(cause.message)) throw error;
    rejected = true;
  }
  if (!rejected) throw new Error('Drizzle accepted a duplicate unique key');
  const rows = db.select().from(messages).where(eq(messages.key, 'duplicate')).all();
  if (rows.length !== 1 || rows[0]?.value !== 'first') throw new Error('Rejected Drizzle write changed the database');
  console.log('${productMarker}: drizzle unique rejection');
} finally {
  sqlite.close();
}
`,
    },
    commands: [
      { name: "generate", args: ["run", "node_modules/drizzle-kit/bin.cjs", "generate", "--config=drizzle.config.ts", "--name=product"], check: { kind: "files", paths: ["drizzle/0000_product.sql"], text: "CREATE TABLE" } },
      { name: "schema", after: "generate", args: ["run", "migrate.ts"], check: { kind: "stdout", text: `${productMarker}: drizzle schema` } },
      { name: "query", after: "schema", args: ["run", "query.ts"], check: { kind: "stdout", text: `${productMarker}: drizzle query` } },
      { name: "reject", after: "schema", args: ["run", "reject.ts"], check: { kind: "stdout", text: `${productMarker}: drizzle unique rejection` } },
    ],
    features: ["generate:drizzle-kit-sql-migration", "schema:apply-generated-migration", "query:bun-sqlite-file", "query:create-update-read", "reject:database-unique-constraint", "build:not-applicable:migration-generation-is-generate-stage"],
  },
  {
    id: "typescript",
    family: "tool",
    dependencies: { typescript: "5.9.3" },
    files: {
      "src/message.ts": `export function message(name: string): string { return '${productMarker}: ' + name; }\n`,
      "src/index.ts": `import { message } from './message.js';
const actual = message('typescript');
if (actual !== '${productMarker}: typescript') throw new Error('Emitted import or function mismatch');
console.log(actual);
`,
      "controls/invalid.ts": "const value: string = 42;\nexport { value };\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", rootDir: "src", outDir: "dist", noEmitOnError: true }, include: ["src/**/*.ts"] }, null, 2),
    },
    commands: [
      { name: "check", args: ["run", "node_modules/typescript/bin/tsc", "--noEmit", "--pretty", "false"], check: { kind: "diagnostics", exit: 0, texts: [] } },
      { name: "reject", args: ["run", "node_modules/typescript/bin/tsc", "--noEmit", "--pretty", "false", "--strict", "controls/invalid.ts"], check: { kind: "diagnostics", exit: 2, texts: ["error TS2322", "Type 'number' is not assignable to type 'string'"] } },
      { name: "build", args: ["run", "node_modules/typescript/bin/tsc", "--pretty", "false"], check: { kind: "files", paths: ["dist/index.js", "dist/message.js"], text: productMarker } },
      { name: "run", after: "build", args: ["run", "dist/index.js"], check: { kind: "stdout", text: `${productMarker}: typescript` } },
    ],
    features: ["check:strict-types", "reject:assignment-diagnostic-and-exit", "build:two-emitted-modules", "run:emitted-import"],
  },
  {
    id: "eslint",
    family: "tool",
    dependencies: { eslint: "9.38.0", "@typescript-eslint/parser": "8.46.1", typescript: "5.9.3", jiti: "2.6.1" },
    files: {
      "index.ts": "export const message: number = 1;\n",
      "controls/invalid.ts": "debugger;\nexport const message: number = 1;\n",
      "eslint.config.ts": `import parser from '@typescript-eslint/parser';
export default [{ files: ['**/*.ts'], languageOptions: { parser }, rules: { 'no-debugger': 'error' } }];
`,
    },
    commands: [
      { name: "lint", args: ["run", "node_modules/eslint/bin/eslint.js", "--format", "json", "--no-cache", "index.ts"], check: { kind: "stdout", text: '"errorCount":0' } },
      { name: "reject", args: ["run", "node_modules/eslint/bin/eslint.js", "--format", "json", "--no-cache", "controls/invalid.ts"], check: { kind: "diagnostics", exit: 1, texts: ['"ruleId":"no-debugger"', `"message":"Unexpected 'debugger' statement."`, '"errorCount":1'] } },
    ],
    features: ["lint:typescript-parser", "lint:flat-typescript-config", "reject:rule-diagnostic-and-exit", "build:not-applicable:linter"],
  },
];
