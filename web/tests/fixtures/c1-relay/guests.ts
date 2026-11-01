// P1's real pg query, without its retired host composition or custody checks.
// The disposable database password is passed privately through the ordinary guest environment.
export const pgQuery = `
import { Client } from "pg";
if (!process.env.PGPASSWORD) throw new Error("C1 database password was not forwarded");
const client = new Client({ password: process.env.PGPASSWORD, host: "pg.waffle.internal", port: 5432, user: "postgres", database: "postgres", ssl: false });
try {
  await client.connect();
  const result = await client.query("SELECT 1");
  if (result.rows.length !== 1 || result.rows[0]?.["?column?"] !== 1) throw new Error("unexpected SELECT 1 result");
  console.log("C1_PG_SELECT_1_OK");
} finally { await client.end(); }
`;

export const noRelay = `
import { connect } from "node:net";
const server = Bun.serve({ port: 31979, fetch() { return new Response("C1 loopback"); } });
try {
  if (await (await fetch("http://localhost:31979/")).text() !== "C1 loopback") throw new Error("loopback regression");
} finally { server.stop(true); }
await new Promise((resolve, reject) => {
  const socket = connect({ host: "pg.waffle.internal", port: 5432 });
  socket.on("connect", () => { socket.destroy(); reject(new Error("no-relay outbound connect unexpectedly succeeded")); });
  socket.on("error", error => { if (error.code === "ENOTSUP") resolve(); else reject(error); });
});
console.log("C1_NO_RELAY_LOOPBACK_ENOTSUP_OK");
`;
