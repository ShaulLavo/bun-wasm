// bun:sqlite parameter binding: positional, numbered, named, strict mode,
// value types and safe integers.
const { Database } = require("bun:sqlite");

function attempt(label, fn) {
  try {
    console.log(label, fn());
  } catch (err) {
    console.log(label, `${err.name}: ${err.message}`);
  }
}

const db = new Database(":memory:");
const one = db.query("select ? as v, typeof(?1) as t");
attempt("int:", () => one.get(42));
attempt("whole double:", () => one.get(3.0));
attempt("real:", () => one.get(2.5));
attempt("negative zero:", () => one.get(-0));
attempt("big number:", () => one.get(2 ** 60));
attempt("bigint:", () => one.get(123n));
attempt("bigint wraps:", () => one.get(2n ** 64n + 5n));
attempt("true:", () => one.get(true));
attempt("false:", () => one.get(false));
attempt("string:", () => one.get("héllo ✓"));
attempt("empty string:", () => one.get(""));
attempt("null:", () => one.get(null));
attempt("undefined:", () => one.get(undefined));
attempt("Uint8Array:", () => one.get(new Uint8Array([9, 8])));
attempt("Buffer:", () => one.get(Buffer.from("hi")));
attempt("Uint16Array:", () => one.get(new Uint16Array([1, 256])));
attempt("empty blob:", () => one.get(new Uint8Array(0)));
attempt("Date:", () => one.get(new Date(0)));
attempt("symbol:", () => one.get(Symbol("s")));
attempt("array arg:", () => one.get([7]));
attempt("kept bindings:", () => one.get());

const two = db.query("select ? as a, ? as b");
attempt("spread:", () => two.get(1, 2));
attempt("array:", () => two.get([3, 4]));
attempt("too many:", () => two.get(1, 2, 3));
attempt("too few:", () => two.get([1]));
attempt("empty array:", () => two.get([]));

const numbered = db.query("select ?2 as second, ?1 as first");
attempt("numbered:", () => numbered.get("one", "two"));

const named = db.query("select $a as a, :b as b, @c as c");
attempt("named:", () => named.get({ $a: 1, ":b": 2, "@c": 3 }));
attempt("named no prefix:", () => named.get({ a: 1, b: 2, c: 3 }));
attempt("named partial:", () => named.get({ $a: "only a" }));

const strict = new Database(":memory:", { strict: true });
const sn = strict.query("select $a as a, :b as b");
attempt("strict named:", () => sn.get({ a: 1, b: 2 }));
attempt("strict with prefix:", () => sn.get({ $a: 1, b: 2 }));
attempt("strict missing:", () => sn.get({ a: 1 }));
attempt("strict positional:", () => strict.query("select ? as x, ? as y").get({ 0: "p", 1: "q" }));
attempt("strict positional missing:", () => strict.query("select ? as x, ? as y").get({ 0: "p" }));
attempt("strict numbered:", () => strict.query("select ?2 as x, ?1 as y").get({ 1: "first", 2: "second" }));
attempt("strict numbered array:", () => strict.query("select ?2 as x, ?1 as y").get(["first", "second"]));
strict.run("create table kv (k text primary key, v)");
attempt("strict run:", () => strict.run("insert into kv values ($k, $v)", { k: "a", v: 1 }));
attempt("strict run missing:", () => strict.run("insert into kv values ($k, $v)", { k: "b" }));
attempt("strict rows:", () => strict.query("select * from kv").all());

db.run("create table t (a, b)");
attempt("run positional:", () => db.run("insert into t values (?, ?)", 1, "x"));
attempt("run array:", () => db.run("insert into t values (?, ?)", [2, "y"]));
attempt("run named:", () => db.run("insert into t values ($a, $b)", { $a: 3, $b: "z" }));
attempt("run multi:", () => db.run("insert into t values (4, 'w'); insert into t values (5, 'v');"));
attempt("exec:", () => db.exec("update t set b = upper(b) where a > ?", 3));
attempt("rows:", () => db.query("select * from t order by a").values());
const prepared = db.prepare("select ? as bound", ["at prepare"]);
attempt("prepare params:", () => prepared.get());
attempt("prepare named params:", () => db.prepare("select $x as x", { $x: 9 }).get());

const safe = new Database(":memory:", { safeIntegers: true });
attempt("safe read:", () => safe.query("select 9007199254740993 as big, 1.5 as f, 7 as small").get());
attempt("safe bind:", () => safe.query("select ? as v").get(9007199254740993n));
attempt("safe out of range:", () => safe.query("select ? as v").get(2n ** 63n));
attempt("safe run:", () => safe.run("select 1"));
attempt("unsafe big:", () => db.query("select 9007199254740993 as big").get());
const toggled = db.query("select 5 as n");
attempt("toggle safeIntegers:", () => [toggled.safeIntegers(), toggled.safeIntegers(true).get(), toggled.safeIntegers()]);
