/**
 * A press of Call that arrived before the connection was up. It is only honoured for a short while:
 * if the connection takes minutes, the person has long moved on, and a call that starts by itself
 * (a chime, an open microphone) would be a surprise. After the window it is simply forgotten.
 */
export class PendingPress {
  private at: number | undefined;

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The person pressed Call and there was no connection yet. */
  request(): void {
    this.at = this.now();
  }

  /** The connection is up. True once, and only if the press is still fresh. */
  take(): boolean {
    const at = this.at;
    this.at = undefined;
    return at !== undefined && this.now() - at <= this.windowMs;
  }

  /** The person hung up, or the connection can never work. */
  clear(): void {
    this.at = undefined;
  }
}
