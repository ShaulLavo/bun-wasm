// bun:sqlite with database files on the WASI filesystem: create, reopen,
// readonly, journaling, serialize/deserialize.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "fs";

mkdirSync("data", { recursive: true });
const path = "data/app.sqlite";

const db = new Database(path, { create: true });
console.log("filename:", db.filename, existsSync(path));
console.log("journal_mode:", db.query("pragma journal_mode").get());
db.run("create table notes (id integer primary key, body text)");
const add = db.prepare("insert into notes (body) values (?)");
db.transaction((bodies) => bodies.forEach((b) => add.run(b)))(["first", "second", "third"]);
console.log("rows:", db.query("select count(*) as n from notes").get());
db.close();
console.log("size > 0:", statSync(path).size > 0, "journal gone:", !existsSync(path + "-journal"));

const again = Database.open(path);
console.log("reopened:", again.query("select body from notes order by id").values());
again.run("delete from notes where id = 2");
again.close();

const ro = new Database(path, { readonly: true });
console.log("readonly read:", ro.query("select count(*) as n from notes").get());
try {
  ro.run("insert into notes (body) values ('nope')");
} catch (err) {
  console.log("readonly write:", err.code, err.message);
}
ro.close();

const second = new Database("data/second.sqlite");
second.run("create table x (a)");
second.run("insert into x values (1)");
console.log("second file:", second.query("select count(*) as n from x").get());
second.close();

// serialize/deserialize round trip through bytes.
const mem = new Database();
mem.run("create table t (v text)");
mem.run("insert into t values ('hello'), ('world')");
const bytes = mem.serialize();
console.log("serialize:", bytes instanceof Uint8Array, bytes.length % 512 === 0, Buffer.isBuffer(bytes));
const copy = Database.deserialize(bytes);
console.log("deserialized:", copy.filename, copy.query("select v from t").values());
copy.run("insert into t values ('more')");
console.log("writable copy:", copy.query("select count(*) as n from t").get(), "original:", mem.query("select count(*) as n from t").get());
const frozen = Database.deserialize(bytes, true);
try {
  frozen.run("insert into t values ('x')");
} catch (err) {
  console.log("readonly copy:", err.code);
}
const fromBuffer = new Database(new Uint8Array(bytes));
console.log("from Uint8Array:", fromBuffer.query("select count(*) as n from t").get());

// Attach a second file.
const main = new Database("data/main.sqlite");
main.run("attach database 'data/other.sqlite' as other");
main.run("create table other.items (name text)");
main.run("insert into other.items values ('attached')");
console.log("attached:", main.query("select name from other.items").get());
main.close();
console.log("files:", ["app.sqlite", "second.sqlite", "main.sqlite", "other.sqlite"].map((f) => existsSync("data/" + f)).join(","));
