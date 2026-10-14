// bun:sqlite basics: queries, statements, result shapes, transactions.
import { Database, Statement, constants } from "bun:sqlite";
import DefaultDatabase from "bun:sqlite";

const cjs = require("bun:sqlite");
console.log("module:", DefaultDatabase === Database, cjs.Database === Database, cjs.default === Database, typeof Statement);
console.log("constants:", constants.SQLITE_OPEN_READONLY, constants.SQLITE_OPEN_CREATE, constants.SQLITE_PREPARE_PERSISTENT);

const db = new Database();
console.log("filename:", JSON.stringify(db.filename), "inTransaction:", db.inTransaction);
console.log("version:", typeof db.query("select sqlite_version() as v").get().v);

db.run("create table people (id integer primary key, name text not null, age integer, score real, photo blob)");
const insert = db.prepare("insert into people (name, age, score, photo) values (?, ?, ?, ?)");
console.log("paramsCount:", insert.paramsCount);
console.log(insert.run("Ada", 36, 9.5, new Uint8Array([1, 2, 3])));
console.log(insert.run(["Grace", 45, 8.25, null]));
console.log(db.run("insert into people (name, age) values ('Linus', 21), ('Ken', 70)"));

const all = db.query("select * from people order by id");
console.log("columnNames:", all.columnNames);
console.log(all.all());
console.log("get:", db.query("select name, age from people where age > ? order by age").get(40));
console.log("get none:", db.query("select name from people where age > 1000").get());
console.log("values:", db.query("select id, name from people order by id").values());
console.log("raw:", db.query("select count(*), 1.5, 'hi', '', null, x'ff' from people").raw());
console.log("all none:", db.query("select * from people where 0").all());
console.log("insert all/values/get:", db.query("insert into people (name) values ('x')").all(), db.query("insert into people (name) values ('y')").values(), db.query("delete from people where name in ('x', 'y')").get());
console.log("returning:", db.query("insert into people (name, age) values ('Z', 1) returning id, name").get());

const names = [];
for (const row of db.query("select name from people order by id").iterate()) names.push(row.name);
console.log("iterate:", names.join(","));
const first = [];
for (const row of db.query("select name from people order by id")) {
  first.push(row.name);
  if (first.length === 2) break;
}
console.log("iterator + break:", first.join(","), "then all:", db.query("select name from people order by id").all().length);

console.log("query cache:", db.query("select 1") === db.query("select 1"), db.prepare("select 1") === db.prepare("select 1"));
console.log("toString:", String(db.query("select ? as a, ? as b")), db.query("select 1 as one").toString());
const shown = db.query("select ?1 as x");
shown.get("it's");
console.log("expanded:", shown.toString(), Object.prototype.toString.call(shown));
console.log("toJSON:", JSON.stringify(db.query("select name from people")));

class Person {
  get label() {
    return `${this.name} (${this.age})`;
  }
}
const people = db.query("select name, age from people where age is not null order by age").as(Person).all();
console.log("as:", people[0] instanceof Person, people.map((p) => p.label).join("; "), Object.keys(people[0]));

console.log("duplicate columns:", db.query("select 1 as a, 2 as a, 3 as b").get());
console.log("types:", db.query("select 1 as i, 1.5 as f, 'x' as t, x'00ff' as b, null as n, 2.0 as whole").get());
console.log("columnTypes:", db.query("select id, name, score, photo from people where id = 1").columnTypes);
const declared = db.query("select id, name, 1 + 1 as two from people");
declared.all();
console.log("declaredTypes:", declared.declaredTypes);

// Transactions: commit, rollback on throw, nesting through savepoints.
db.run("create table ledger (amount integer)");
const add = db.prepare("insert into ledger values (?)");
const addMany = db.transaction((amounts) => {
  for (const amount of amounts) add.run(amount);
  return db.inTransaction;
});
console.log("transaction:", addMany([1, 2, 3]), db.inTransaction);
try {
  db.transaction(() => {
    add.run(100);
    throw new Error("boom");
  })();
} catch (err) {
  console.log("rolled back:", err.message, db.inTransaction);
}
const nested = db.transaction(() => {
  addMany([10]);
  try {
    db.transaction(() => {
      add.run(1000);
      throw new Error("inner");
    })();
  } catch {}
  return db.query("select sum(amount) as total from ledger").get().total;
});
console.log("nested:", nested(), "after:", db.query("select sum(amount) as total from ledger").get().total);
console.log("variants:", typeof addMany.deferred, typeof addMany.immediate, typeof addMany.exclusive, addMany.database === db);
console.log("immediate:", addMany.immediate([4]), addMany.exclusive([5]), addMany.deferred([6]));
console.log("total:", db.query("select count(*) as n, sum(amount) as total from ledger").get());

// SQLite features compiled in: JSON, math, FTS5, R*Tree, window functions.
console.log("json:", db.query(`select json_extract('{"a":[1,2,{"b":"c"}]}', '$.a[2].b') as v, json_array(1, 'x') as arr`).get());
console.log("math:", db.query("select sqrt(16) as s, pow(2, 10) as p, floor(2.7) as f").get());
db.run("create virtual table docs using fts5(body)");
db.run("insert into docs values ('the quick brown fox'), ('lazy dogs sleep'), ('quick thinking')");
console.log("fts5:", db.query("select body from docs where docs match 'quick' order by rank").values());
db.run("create virtual table boxes using rtree(id, minX, maxX, minY, maxY)");
db.run("insert into boxes values (1, 0, 10, 0, 10), (2, 20, 30, 20, 30)");
console.log("rtree:", db.query("select id from boxes where minX <= 5 and maxX >= 5").values());
console.log("window:", db.query("select amount, sum(amount) over (order by amount) as running from ledger order by amount limit 4").values());

// A big sort exercises the in-memory temp store.
db.run("create table nums (n integer)");
db.transaction(() => {
  const ins = db.prepare("insert into nums values (?)");
  for (let i = 0; i < 5000; i++) ins.run((i * 7919) % 5000);
})();
console.log("sorted:", db.query("select n from nums order by n desc limit 3").values(), db.query("select count(distinct n) as c from nums").get());

insert.finalize();
console.log("finalized:", insert.isFinalized, db.query("select 1").isFinalized);
db.close();
console.log("closed");
