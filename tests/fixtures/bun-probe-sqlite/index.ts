// bun:sqlite as a Bun author tries it first (docs/bun-api-probe.md). Each check prints one line.
import { Database } from "bun:sqlite";

async function check(name: string, body: () => unknown): Promise<void> {
  try {
    const value = await body();
    console.log(`ok ${name}${value === undefined ? "" : ": " + (typeof value === "string" ? value : Bun.inspect(value))}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}

const db = new Database(":memory:", { strict: true });
await check("create + insert", () => {
  db.run("create table users (id integer primary key autoincrement, name text not null, email text unique)");
  const insert = db.prepare("insert into users (name, email) values ($name, $email)");
  return [insert.run({ name: "Ada", email: "ada@x" }), insert.run({ name: "Grace", email: "grace@x" })];
});
await check("query all/get/values", () => {
  const all = db.query("select id, name from users order by id").all();
  const one = db.query("select name from users where id = ?").get(2);
  const values = db.query("select name, email from users").values();
  return [all, one, values];
});
await check("named params strict", () => db.query("select name from users where name = $name").get({ name: "Ada" }));
await check("transaction", () => {
  const insertMany = db.transaction((rows: { name: string; email: string }[]) => {
    const insert = db.prepare("insert into users (name, email) values ($name, $email)");
    for (const row of rows) insert.run(row);
    return rows.length;
  });
  const count = insertMany([{ name: "Linus", email: "linus@x" }, { name: "Ken", email: "ken@x" }]);
  return [count, db.query("select count(*) as n from users").get()];
});
await check("transaction rollback", () => {
  const bad = db.transaction(() => {
    db.run("insert into users (name, email) values ('Dup', 'ada@x')");
  });
  try {
    bad();
  } catch (error) {
    return [(error as Error).message, db.query("select count(*) as n from users").get()];
  }
  throw new Error("unique constraint did not throw");
});
await check(".as(Class)", () => {
  class User {
    id!: number;
    name!: string;
    get shout() { return this.name.toUpperCase(); }
  }
  const users = db.query("select id, name from users order by id limit 2").as(User).all();
  return [users[0] instanceof User, users.map(user => user.shout)];
});
await check("iterate", () => {
  const names: string[] = [];
  for (const row of db.query("select name from users order by id").iterate() as Iterable<{ name: string }>) names.push(row.name);
  return names;
});
await check("blob + bigint", () => {
  db.run("create table blobs (data blob, big integer)");
  db.query("insert into blobs values (?, ?)").run(new Uint8Array([1, 2, 3]), 2n ** 60n);
  const row = new Database(":memory:", { safeIntegers: true });
  row.run("create table t (n integer)");
  row.run("insert into t values (?)", [9007199254740993n]);
  return [db.query("select data from blobs").get(), row.query("select n from t").get()];
});
await check("run changes/lastInsertRowid", () => db.run("update users set name = name || '!' where id <= 2"));
await check("file database", () => {
  const file = new Database("probe.sqlite", { create: true });
  file.run("create table if not exists kv (k text primary key, v text)");
  file.run("insert or replace into kv values ('a', 'persisted')");
  file.close();
  const reopened = new Database("probe.sqlite", { readonly: true });
  const value = reopened.query("select v from kv").get();
  reopened.close();
  return value;
});
await check("serialize/deserialize", () => {
  const bytes = db.serialize();
  const copy = Database.deserialize(bytes);
  return copy.query("select count(*) as n from users").get();
});
await check("syntax error", () => {
  try {
    db.query("selec nothing");
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("no syntax error");
});
await check("using + close", () => {
  {
    using temp = new Database(":memory:");
    temp.run("create table t (x)");
  }
  db.close();
  return "closed";
});
