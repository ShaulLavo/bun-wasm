(function (internal: { web: { AbortController: typeof AbortController } }) {
  type Connection = {
    closed: boolean;
    readEnded: boolean;
    destroy(): void;
    onClose?: (() => void) | null;
    onEnd?: (() => void) | null;
  };
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
      return await handle(controller.signal);
    } finally {
      active = false;
      if (connection.onClose === close) connection.onClose = previousClose;
      if (connection.onEnd === end) connection.onEnd = previousEnd;
    }
  }
  return { run };
})
