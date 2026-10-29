const order: string[] = [];
const pending = import("./tla/awaited.mts").then(namespace => {
  order.push("import");
  console.log("dynamic cts", namespace.answer, order.join(","));
});
order.push("sync");
pending.catch(error => { throw error; });
