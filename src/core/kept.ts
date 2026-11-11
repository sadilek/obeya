// A value that takes a while to ask for (a harness's models, npm's newest version, a list of
// skills), kept a while and asked afresh behind it, so callers have what was last heard at once.

export interface KeptOptions {
  /** How long a value heard stands before it is asked again. */
  forMs: number;
  /** An ask that failed: what to log. */
  failed: (e: unknown) => void;
  /** A failure forgets the value heard before and asks again next time; else that value stands as if heard anew. */
  forget?: boolean;
  now?: () => number;
}

export class Kept<T> {
  private value: T | undefined;
  /** When it was last heard; none: never, or forgotten. */
  private at: number | undefined;
  private asking: Promise<void> | undefined;

  constructor(
    private ask: () => Promise<T>,
    private o: KeptOptions,
  ) {}

  /** The value as last heard (none before it first was), without asking. */
  get last(): T | undefined {
    return this.value;
  }

  /** The value as last heard, asked again behind it once it is old; one ask at a time. */
  get(): T | undefined {
    const now = this.o.now ?? Date.now;
    if (!this.asking && (this.at === undefined || now() - this.at >= this.o.forMs)) {
      this.asking = this.ask().then(
        (value) => {
          this.value = value;
          this.at = now();
        },
        (e) => {
          this.o.failed(e);
          if (this.o.forget) this.value = this.at = undefined;
          else this.at = now();
        },
      );
      void this.asking.finally(() => (this.asking = undefined));
    }
    return this.value;
  }

  /** The value once the ask under way, if one is, is through. */
  async fresh(): Promise<T | undefined> {
    await this.asking;
    return this.value;
  }

  /** What was heard no longer stands: the next `get` asks again. */
  expire() {
    this.at = undefined;
  }
}
