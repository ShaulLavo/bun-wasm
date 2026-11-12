import { admit, awaitWithin, type Admission } from "./scope";
import type { IphoneSettlement } from "./iphone-bus";

type Turn = { released: Promise<void>; release(): void; work?: Promise<IphoneSettlement> };

/** One dispatched request and one reserved successor per observer role. */
export class IphoneLane {
  private current: Turn | undefined;
  private waiter: symbol | undefined;
  private unavailable: { reason: unknown } | undefined;

  async execute(send: () => Promise<IphoneSettlement>, admission: Admission): Promise<unknown> {
    admit(admission);
    if (this.unavailable) throw this.unavailable.reason;
    const token = Symbol();
    if (this.waiter) throw new Error("iPhone observer lane already has a reserved waiter");
    try {
      if (this.current) await this.wait(this.current, token, admission);
      // dispatch reserves synchronously; release the waiter only after it installs work.
      return this.dispatch(send, admission);
    } finally { if (this.waiter === token) this.waiter = undefined; }
  }

  private async dispatch(send: () => Promise<IphoneSettlement>, admission: Admission): Promise<unknown> {
    admit(admission);
    if (this.unavailable) throw this.unavailable.reason;
    const released = Promise.withResolvers<void>();
    const turn: Turn = { released: released.promise, release: () => released.resolve() };
    this.current = turn;
    try { turn.work = send(); }
    catch (error) { this.finish(turn, { reason: error }); throw error; }
    // Install settlement handling before any caller can wait on this exact request.
    void turn.work.then(() => this.finish(turn), reason => this.finish(turn, { reason }));
    const result = await awaitWithin(turn.work, admission);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  private wait(turn: Turn, token: symbol, admission: Admission): Promise<void> {
    this.waiter = token;
    return awaitWithin(turn.released, admission);
  }

  private finish(turn: Turn, unavailable?: { reason: unknown }): void {
    if (unavailable) this.unavailable = unavailable;
    if (this.current === turn) this.current = undefined;
    turn.release();
  }
}
