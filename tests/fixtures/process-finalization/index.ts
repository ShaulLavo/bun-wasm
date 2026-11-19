// process.finalization: callbacks run from 'beforeExit' and 'exit' listeners appended at the
// first register(), unregister() drops a target, and only the target is validated.
const order: string[] = [];
const kept = { name: "kept" };
const dropped = { name: "dropped" };
const record = (target: { name: string }, event: string) => order.push(`finalization ${target.name} ${event}`);
process.on("exit", () => order.push("user exit listener"));
process.finalization.register(kept, record);
process.finalization.register(dropped, 123 as never);
process.finalization.unregister(dropped);
process.finalization.registerBeforeExit(kept, record);
try {
  process.finalization.register(1 as never, record);
} catch (error) {
  console.log(error.code, error.message);
}
process.on("exit", () => console.log(order.join("\n"), kept.name));
