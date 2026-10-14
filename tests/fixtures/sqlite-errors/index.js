// bun:sqlite errors: SQLiteError codes, messages and misuse.
import { Database, SQLiteError } from "bun:sqlite";

function attempt(label, fn) {
  try {
    console.log(label, fn());
  } catch (err) {
    const extra = err.name === "SQLiteError" ? ` code=${err.code} errno=${err.errno} byteOffset=${err.byteOffset}` : "";
    console.log(label, `${err.name}: ${err.message}${extra}`, err instanceof Error, err instanceof SQLiteError, Object.keys(err));
  }
}

const db = new Database();
db.run("create table users (id integer primary key, email text unique not null, age integer check (age >= 0))");
db.run("insert into users (email, age) values ('a@x', 1)");
attempt("unique:", () => db.run("insert into users (email, age) values ('a@x', 2)"));
attempt("not null:", () => db.run("insert into users (email) values (null)"));
attempt("check:", () => db.run("insert into users (email, age) values ('b@x', -1)"));
attempt("primary key:", () => db.run("insert into users (id, email) values (1, 'c@x')"));
attempt("syntax:", () => db.query("selec * from users"));
attempt("syntax offset:", () => db.query("select * from users wher id = 1"));
attempt("no table:", () => db.query("select * from nope"));
attempt("no column:", () => db.run("update users set nope = 1"));
attempt("run syntax:", () => db.run("create table ok (a); create tabl bad (b)"));
attempt("partial run kept:", () => db.query("select name from sqlite_master where name = 'ok'").get());
attempt("blank run:", () => db.run(""));
attempt("empty run:", () => db.run("  ;  "));
attempt("comment run:", () => db.run("-- nothing"));
attempt("empty query:", () => db.query(""));
attempt("blank prepare:", () => db.prepare("   "));
attempt("query type:", () => db.query(42));
attempt("bad binding:", () => db.query("select ?").get({}.toString));
attempt("construct SQLiteError:", () => new SQLiteError());
attempt("anonymous readonly:", () => new Database(":memory:", { readonly: true }));
attempt("missing readonly:", () => new Database("missing.sqlite", { readonly: true }));
attempt("missing no create:", () => new Database("missing.sqlite", { readwrite: true }));
attempt("readOnly typo:", () => new Database("x.sqlite", { readOnly: true }));
attempt("filename type:", () => new Database(5));
attempt("transaction arg:", () => db.transaction(5));
attempt("load extension:", () => typeof db.loadExtension);

// After an error the statement is usable again.
const insert = db.prepare("insert into users (email) values (?)");
attempt("first:", () => insert.run("dup@x"));
attempt("again:", () => insert.run("dup@x"));
attempt("reused:", () => insert.run("fresh@x"));

// Foreign keys stay off by default, as in Bun.
attempt("foreign_keys:", () => db.query("pragma foreign_keys").get());

const stmt = db.prepare("select * from users");
stmt.finalize();
attempt("finalized:", () => stmt.all());
const cached = db.query("select count(*) as n from users");
const kept = db.prepare("select count(*) as n from users");
db.close();
attempt("closed query:", () => db.query("select 1"));
attempt("closed run:", () => db.run("select 1"));
attempt("closed cached:", () => cached.get());
attempt("prepared survives close:", () => kept.get());
kept.finalize();
attempt("close twice:", () => db.close());
