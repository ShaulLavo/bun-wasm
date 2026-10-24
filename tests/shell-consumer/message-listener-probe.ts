export class MessageListenerProbe {
  private probe: MessageEvent | undefined;
  private reached = 0;
  readonly listener: EventListener;

  constructor(private readonly target: EventTarget, onMessage: (event: MessageEvent) => void) {
    this.listener = event => {
      if (event === this.probe) { this.reached++; return; }
      if (event instanceof MessageEvent) onMessage(event);
    };
  }

  count() {
    this.reached = 0;
    this.probe = new MessageEvent("message");
    try { this.target.dispatchEvent(this.probe); return this.reached; }
    finally { this.probe = undefined; }
  }

  assertRemoved() {
    const count = this.count();
    if (count !== 0) throw new Error(`zero owned page listeners, got ${count}`);
    return count;
  }
}
