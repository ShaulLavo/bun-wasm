// Child guest for the IPC and spawn rows: `exit <code>`, `ipc-burst` or `ipc-wait`.
const [mode, argument] = process.argv.slice(2);

function field(message: unknown, name: string): unknown {
  return message !== null && typeof message === "object" ? Reflect.get(message, name) : undefined;
}

function send(message: object, callback?: () => void): void {
  if (!process.send) throw new Error("payload needs an IPC channel");
  process.send(message, undefined, undefined, callback);
}

function onMessage(message: unknown): void {
  const kind = field(message, "kind");
  if (kind === "exit") process.exit(0);
  if (kind === "stall") return void Bun.sleepSync(Number(field(message, "ms")));
  if (field(message, "ack") === true) send({ ack: field(message, "n") });
}

switch (mode) {
  case "exit":
    process.exit(Number(argument));
    break;
  case "ipc-burst":
    send({ n: 1 });
    send({ n: 2 }, () => process.exit(0));
    break;
  case "ipc-wait":
    process.on("message", onMessage);
    process.on("disconnect", () => process.exit(0));
    send({ kind: "ready" });
    break;
  default:
    throw new Error(`unknown payload mode ${mode}`);
}
