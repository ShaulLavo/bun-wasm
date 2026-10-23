// AsyncLocalStorage's defaultValue and name options (Node 24+, Bun).
import { AsyncLocalStorage } from "node:async_hooks";

const show = (label: string, value: unknown) => console.log(label, JSON.stringify(value) ?? "undefined");

const plain = new AsyncLocalStorage();
show("plain store", plain.getStore());
show("plain name", plain.name);

const als = new AsyncLocalStorage({ defaultValue: "default", name: "requests" });
show("default store", als.getStore());
show("name", als.name);
als.run("bound", () => {
  show("run", als.getStore());
  als.exit(() => show("exit", als.getStore()));
  als.run(undefined, () => show("run undefined", als.getStore()));
});
show("after run", als.getStore());

for (const defaultValue of [42, null, 0, false]) {
  show(`default ${String(defaultValue)}`, new AsyncLocalStorage({ defaultValue }).getStore());
}
show("numeric name", new AsyncLocalStorage({ name: 7 }).name);

const awaited = new AsyncLocalStorage({ defaultValue: "outer" });
await awaited.run("inner", async () => {
  await null;
  show("after await", awaited.getStore());
});
setTimeout(() => show("timer", awaited.getStore()), 0);

const disabled = new AsyncLocalStorage({ defaultValue: "fallback" });
disabled.enterWith("entered");
show("entered", disabled.getStore());
disabled.disable();
show("disabled", disabled.getStore());

for (const options of [null, "options", 1, []]) {
  try {
    new AsyncLocalStorage(options as never);
    console.log("accepted", JSON.stringify(options));
  } catch (error) {
    const { code, message } = error as { code: string; message: string };
    console.log(code, message);
  }
}
