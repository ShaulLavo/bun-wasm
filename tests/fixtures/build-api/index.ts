// Bun.build: one file with every import external and React Fast Refresh, in-memory outputs
// with code splitting, and a failed build.
const one = await Bun.build({ entrypoints: ["./src/App.tsx"], external: ["*"], reactFastRefresh: true, target: "browser" });
console.log(one.success, one.outputs.length, one.logs.length);
const [app] = one.outputs;
console.log(app.path, app.kind, app.loader, app.type);
// The hook signature hashes the hook calls' AST bytes, so it differs on 32-bit targets.
console.log((await app.text()).replace(/_s\((\w+), "[^"]+"\)/g, '_s($1, "SIGNATURE")'));

const split = await Bun.build({ entrypoints: ["./src/a.ts", "./src/b.ts"], splitting: true, minify: true });
const names = split.outputs.map((o) => `${o.kind} ${o.path.replace(/chunk-[a-z0-9]+/, "chunk-HASH")}`);
console.log(names.sort().join("\n"));
const chunk = split.outputs.find((o) => o.kind === "chunk");
console.log((await chunk.text()).includes("count: "));

try {
  await Bun.build({ entrypoints: ["./src/bad.ts"] });
  console.log("no error");
} catch (err) {
  console.log(err.constructor.name, err.message.split("\n")[0], err.errors.length > 0);
}
const quiet = await Bun.build({ entrypoints: ["./src/bad.ts"], throw: false });
console.log(quiet.success, quiet.outputs.length, quiet.logs.length > 0, quiet.logs[0].level);
