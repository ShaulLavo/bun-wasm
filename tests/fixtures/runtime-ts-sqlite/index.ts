import { Database, SQLiteError, Statement } from "bun:sqlite";
import { deepStrictEqual, equal, ok, throws } from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const directory = "sqlite-owned";
mkdirSync(directory);
const databases: Database[] = [];
const statements: Statement[] = [];
function database(path = ":memory:", options?: ConstructorParameters<typeof Database>[1]) {
  const db = new Database(path, options);
  databases.push(db);
  return db;
}
function prepared(db: Database, query: string) {
  const stmt = db.prepare(query);
  statements.push(stmt);
  return stmt;
}

try {
  const db = database();
  db.run("create table ledger (id integer primary key, amount integer, note text unique)");
  const insert = prepared(db, "insert into ledger (amount, note) values (?, ?)");
  deepStrictEqual(insert.run([1, "one"]), { changes: 1, lastInsertRowid: 1 });
  deepStrictEqual(db.exec("insert into ledger (amount, note) values (2, 'two')"), { changes: 1, lastInsertRowid: 2 });
  equal(db.exec, db.run);
  const select = db.query("select amount, note from ledger order by id");
  equal(select, db.query("select amount, note from ledger order by id"));
  ok(select instanceof Statement);
  deepStrictEqual(select.get(), { amount: 1, note: "one" });
  deepStrictEqual(select.values(), [[1, "one"], [2, "two"]]);
  deepStrictEqual(Array.from(select.iterate()), select.all());
  deepStrictEqual(Array.from(select), select.all());
  equal(db.query("select * from ledger where 0").get(), null);
  deepStrictEqual(db.query("select * from ledger where 0").all(), []);
  deepStrictEqual(db.query("select * from ledger where 0").values(), []);
  equal(db.query("select 1 as value, 2 as value").get()?.value, 2);
  const raw = db.query("select 1, 1.5, 'x', x'00ff', null").raw();
  deepStrictEqual(raw?.map(row => row.map(value => value === null ? null : Array.from(value))), [
    [[1, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 248, 63], [120], [0, 255], null],
  ]);
  class Row {}
  equal(select.as(Row), select);
  ok(select.get() instanceof Row);
  ok(select.all().every(row => row instanceof Row));
  ok(Array.from(select).every(row => row instanceof Row));
  const initial = db.prepare("select $v as value", { $v: "kept" });
  statements.push(initial);
  deepStrictEqual(initial.get(), { value: "kept" });
  deepStrictEqual(initial.get({ $v: 9 }), { value: 9 });
  deepStrictEqual(initial.get(), { value: 9 });
  deepStrictEqual(initial.toJSON(), { sql: "select 9 as value", isFinalized: false, paramsCount: 1, columnNames: ["value"] });
  deepStrictEqual(select.columnTypes, ["INTEGER", "TEXT"]);
  select.all();
  deepStrictEqual(select.declaredTypes, ["INTEGER", "TEXT"]);
  console.log("statement shapes, identity and metadata pass");

  const strict = database(":memory:", { strict: true, safeIntegers: true });
  const named = strict.query("select $a as a, :b as b, @c as c");
  deepStrictEqual(named.get({ a: true, b: undefined, c: new Uint8Array([1, 2]) }), { a: 1n, b: null, c: new Uint8Array([1, 2]) });
  throws(() => named.get({ a: 1 }), /Missing parameter/);
  throws(() => named.get([1]), /expected 3 values/);
  deepStrictEqual(strict.query("select ?2 as second, ?1 as first").get(["one", "two"]), { second: "two", first: "one" });
  const safe = strict.query("select ? as value, 1.5 as fraction");
  equal(safe.safeIntegers(), true);
  deepStrictEqual(safe.get(9007199254740993n), { value: 9007199254740993n, fraction: 1.5 });
  throws(() => safe.get(2n ** 63n), RangeError);
  throws(() => safe.get([new Date(0)]), TypeError);
  equal(safe.safeIntegers(false), safe);
  deepStrictEqual(safe.get(7n), { value: 7, fraction: 1.5 });
  const blob = new Uint8Array([9, 8, 7, 6]);
  deepStrictEqual(db.query("select ? as value").get(new DataView(blob.buffer, 1, 2))?.value, new Uint8Array([8, 7]));
  console.log("bindings and safe integer conversion pass");

  const marker = new Error("rollback marker");
  const receiver = { label: "receiver" };
  const transaction = db.transaction(function (this: typeof receiver, amount: number, note: string) {
    equal(this, receiver);
    equal(db.inTransaction, true);
    insert.run(amount, note);
    return note;
  });
  equal(transaction.database, db);
  equal(transaction.default, transaction);
  for (const [index, mode] of [transaction, transaction.deferred, transaction.immediate, transaction.exclusive].entries()) {
    equal(mode.database, db);
    equal(mode.default, transaction);
    equal(mode.call(receiver, 3, `mode-${index}`), `mode-${index}`);
  }
  const count = db.query("select count(*) as n from ledger").get()?.n;
  const nested = db.transaction(() => {
    throws(() => db.transaction(() => { insert.run(99, "inner"); throw marker; })(), error => error === marker);
    equal(db.inTransaction, true);
    insert.run(4, "outer");
    return "committed";
  });
  equal(nested(), "committed");
  equal(db.query("select count(*) as n from ledger where note = 'inner'").get()?.n, 0);
  equal(db.query("select count(*) as n from ledger").get()?.n, Number(count) + 1);
  throws(() => db.transaction(() => { insert.run(100, "rollback"); throw marker; })(), error => error === marker);
  equal(db.inTransaction, false);
  equal(db.query("select count(*) as n from ledger where note = 'rollback'").get()?.n, 0);
  throws(() => insert.run(8, "one"), error => error instanceof SQLiteError && error.code === "SQLITE_CONSTRAINT_UNIQUE");
  equal(insert.run(8, "recovered").changes, 1);
  console.log("transaction modes, receiver, nested rollback and error reuse pass");

  const cached = db.query("select 'cached' as value");
  cached.finalize();
  ok(cached.isFinalized);
  ok(db.query("select 'cached' as value") !== cached);
  const next = db.query("select 'cached' as value");
  db.clearQueryCache();
  ok(next.isFinalized);
  const file = database(`${directory}/owned.sqlite`);
  file.run("create table owned (value text)");
  file.run("insert into owned values ('owned')");
  file.close();
  const reopened = database(`${directory}/owned.sqlite`, { readonly: true });
  equal(reopened.query("select value from owned").get()?.value, "owned");
  throws(() => reopened.run("insert into owned values ('no')"), error => error instanceof SQLiteError);
  const image = db.serialize();
  ok(Buffer.isBuffer(image));
  const clone = Database.deserialize(image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength));
  databases.push(clone);
  equal(clone.query("select count(*) as n from ledger").get()?.n, db.query("select count(*) as n from ledger").get()?.n);
  const loose = database();
  const owned = loose.query("select 1 as value");
  const kept = prepared(loose, "select 2 as value");
  loose.close();
  ok(owned.isFinalized);
  equal(kept.isFinalized, false);
  equal(kept.get()?.value, 2);
  throws(() => loose.query("select 3"), RangeError);
  kept.finalize();
  throws(() => kept.get(), Error);
  const forced = database();
  const finalized = prepared(forced, "select 4");
  forced.close(true);
  ok(finalized.isFinalized);
  console.log("cache, file ownership, serialization and close lifecycle pass");
} finally {
  for (const stmt of statements) stmt.finalize();
  for (const db of databases) db.close(true);
  rmSync(directory, { recursive: true, force: true });
}
equal(existsSync(directory), false);
console.log("owned database cleanup pass");
