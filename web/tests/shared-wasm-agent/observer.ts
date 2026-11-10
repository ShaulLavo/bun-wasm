// Turns Web Lock snapshots into the two facts fixtures rely on. An agent is armed only once its
// lifetime lock is actually held: a pending request can vanish without any agent having held it.

export interface AgentLockEvents {
  armed(tag: string): void;
  closed(tag: string): void;
}

/** Only `held`: a snapshot's `pending` entries have not been granted. */
export function heldLockNames(snapshot: LockManagerSnapshot): ReadonlySet<string | undefined> {
  return new Set((snapshot.held ?? []).map(lock => lock.name));
}

export class AgentLockObserver {
  private readonly armed = new Set<string>();
  private readonly closed = new Set<string>();

  constructor(private readonly events: AgentLockEvents) {}

  observe(agents: ReadonlyMap<string, string>, held: ReadonlySet<string | undefined>): void {
    for (const [tag, id] of agents) this.observeAgent(tag, id, held);
  }

  private observeAgent(tag: string, id: string, held: ReadonlySet<string | undefined>): void {
    if (held.has(id)) return this.arm(tag);
    if (!this.armed.has(tag) || this.closed.has(tag)) return;
    this.closed.add(tag);
    this.events.closed(tag);
  }

  private arm(tag: string): void {
    if (this.armed.has(tag)) return;
    this.armed.add(tag);
    this.events.armed(tag);
  }
}
