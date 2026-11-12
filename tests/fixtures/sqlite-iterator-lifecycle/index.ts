import { Database, SQLiteError, Statement } from "bun:sqlite";
import { deepStrictEqual, doesNotThrow, equal, ok, throws } from "node:assert";

const select = "select id from items order by id";
const marker = new Error("iterator body marker");

function withItems(action: (db: Database, statement: Statement) => void) {
  const db = new Database(":memory:");
  try {
    db.run("create table items (id integer primary key); insert into items values (1), (2)");
    action(db, db.query(select));
  } finally {
    db.close(true);
  }
}

function drop(db: Database) {
  doesNotThrow(() => db.run("drop table items"), "closed iterator must release the table read lock");
}

function breakAfterFirst(rows: Iterable<{ id?: unknown }>) {
  for (const row of rows) {
    equal(row.id, 1);
    return;
  }
  throw new Error("expected the first row");
}

function declaredState(statement: Statement) {
  try {
    return statement.declaredTypes;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
}

function throwFromBody(statement: Statement, dispose: () => void = () => {}) {
  for (const row of statement.iterate()) {
    equal(row.id, 1);
    dispose();
    throw marker;
  }
  throw new Error("expected the first row");
}

withItems((db, statement) => {
  for (const row of statement.iterate()) {
    equal(row.id, 1);
    break;
  }
  drop(db);
});

withItems((db, statement) => {
  const iterator = statement.iterate();
  equal(iterator.next().value?.id, 1);
  deepStrictEqual(iterator.return(undefined), { value: undefined, done: true });
  deepStrictEqual(iterator.return(undefined), { value: undefined, done: true });
  drop(db);
});

withItems((db, statement) => {
  throws(() => throwFromBody(statement), error => error === marker);
  drop(db);
});

withItems((db, statement) => {
  for (const row of statement) {
    equal(row.id, 1);
    break;
  }
  drop(db);
});

withItems((db, statement) => {
  deepStrictEqual(Array.from(statement.iterate()), [{ id: 1 }, { id: 2 }]);
  drop(db);
});

withItems((db, statement) => {
  equal(statement.get()?.id, 1);
  drop(db);
});

withItems((db, statement) => {
  const before = declaredState(statement);
  statement.iterate().return(undefined);
  deepStrictEqual(declaredState(statement), before);
  const insert = db.query("insert into items values (3) returning id");
  insert.iterate().return(undefined);
  equal(db.query("select count(*) as count from items").get()?.count, 2);
  drop(db);
});

withItems((db, statement) => {
  equal(statement, db.query(select));
  breakAfterFirst(statement.iterate());
  equal(statement.isFinalized, false);
  deepStrictEqual(statement.declaredTypes, ["INTEGER"]);
  breakAfterFirst(statement.iterate());
  equal(statement, db.query(select));
  equal(statement.get()?.id, 1);
  deepStrictEqual(statement.all(), [{ id: 1 }, { id: 2 }]);
  drop(db);
});

withItems((db) => {
  const named = db.query("select id, $value as value from items order by id");
  const namedRows = named.iterate({ $value: "retained" });
  deepStrictEqual(namedRows.next().value, { id: 1, value: "retained" });
  namedRows.return(undefined);
  equal(named.get()?.value, "retained");
  deepStrictEqual(named.all(), [{ id: 1, value: "retained" }, { id: 2, value: "retained" }]);
  const again = named.iterate();
  deepStrictEqual(again.next().value, { id: 1, value: "retained" });
  again.return(undefined);
  drop(db);
});

withItems((db) => {
  const positional = db.prepare("select id, ? as value from items order by id", [9007199254740993n]);
  try {
    equal(positional.safeIntegers(true), positional);
    const iterator = positional.iterate();
    deepStrictEqual(iterator.next().value, { id: 1n, value: 9007199254740993n });
    iterator.return(undefined);
    equal(positional.safeIntegers(), true);
    deepStrictEqual(positional.get(), { id: 1n, value: 9007199254740993n });
    deepStrictEqual(positional.all(), [{ id: 1n, value: 9007199254740993n }, { id: 2n, value: 9007199254740993n }]);
    drop(db);
  } finally {
    positional.finalize();
  }
});

withItems((db, statement) => {
  const iterator = statement.iterate();
  equal(iterator.next().value?.id, 1);
  statement.finalize();
  doesNotThrow(() => iterator.return(undefined));
  ok(statement.isFinalized);
  drop(db);
});

withItems((db, statement) => {
  throws(() => throwFromBody(statement, () => statement.finalize()), error => error === marker);
  drop(db);
});

withItems((db, statement) => {
  const iterator = statement.iterate();
  equal(iterator.next().value?.id, 1);
  db.close(true);
  doesNotThrow(() => iterator.return(undefined));
  ok(statement.isFinalized);
});

withItems((db, statement) => {
  throws(() => throwFromBody(statement, () => db.close(true)), error => error === marker);
});

withItems((db) => {
  const prepared = db.prepare(select);
  try {
    const iterator = prepared.iterate();
    equal(iterator.next().value?.id, 1);
    db.close();
    equal(prepared.isFinalized, false);
    doesNotThrow(() => iterator.return(undefined));
    equal(prepared.get()?.id, 1);
  } finally {
    prepared.finalize();
  }
});

withItems((db) => {
  throws(() => db.query("select missing from items"), error => error instanceof SQLiteError && error.message.includes("no such column"));
  const statement = db.query("select case when id = 2 then abs(-9223372036854775808) else id end as id from items");
  const iterator = statement.iterate();
  equal(iterator.next().value?.id, 1);
  throws(() => iterator.next(), error => error instanceof SQLiteError && error.code === "SQLITE_ERROR" && error.errno === 1 && error.message.includes("integer overflow"));
  deepStrictEqual(iterator.next(), { value: undefined, done: true });
  drop(db);
});

console.log("SQLite iterator lifecycle passes");
