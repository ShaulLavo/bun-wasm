(function (internal: { web: { AbortController: typeof AbortController } }) {
  type Connection = {
    closed: boolean;
    readEnded: boolean;
    bufferedAmount: number;
    upgraded?: unknown;
    destroy(): void;
    onClose?: (() => void) | null;
    onEnd?: (() => void) | null;
    onDrain?: (() => void) | null;
  };
  async function waitForOutput(connection: Connection, signal: AbortSignal): Promise<void> {
    if (connection.closed || signal.aborted || connection.upgraded || connection.bufferedAmount === 0) return;
    const previousDrain = connection.onDrain;
    let finish = () => {};
    const output = new Promise<void>(resolve => { finish = resolve; });
    const drained = () => { finish(); previousDrain?.(); };
    connection.onDrain = drained;
    signal.addEventListener("abort", finish, { once: true });
    try {
      await output;
    } finally {
      signal.removeEventListener("abort", finish);
      if (connection.onDrain === drained) connection.onDrain = previousDrain;
    }
  }

  async function run<T>(connection: Connection, handle: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new internal.web.AbortController();
    const previousClose = connection.onClose;
    const previousEnd = connection.onEnd;
    let active = true;
    const abort = () => { if (active) controller.abort(); };
    const close = () => { abort(); previousClose?.(); };
    const end = () => { abort(); previousEnd?.(); connection.destroy(); };
    connection.onClose = close;
    connection.onEnd = end;
    if (connection.closed || connection.readEnded) controller.abort();
    try {
      const result = await handle(controller.signal);
      await waitForOutput(connection, controller.signal);
      return result;
    } finally {
      active = false;
      if (connection.onClose === close) connection.onClose = previousClose;
      if (connection.onEnd === end) connection.onEnd = previousEnd;
    }
  }
  return { run };
})
