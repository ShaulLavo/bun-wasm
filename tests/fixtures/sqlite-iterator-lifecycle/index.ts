import { Database } from "bun:sqlite";
import { doesNotThrow, equal } from "node:assert";

const db = new Database(":memory:");
try {
  db.run("create table items (id integer); insert into items values (1), (2)");
  const statement = db.query("select id from items order by id");
  for (const row of statement.iterate()) {
    equal(row.id, 1);
    break;
  }
  doesNotThrow(() => db.run("drop table items"), "closed iterator must release the table read lock");
  console.log("SQLite iterator lifecycle passes");
} finally {
  db.close(true);
}
