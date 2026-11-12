// A timer per card, such as the one that stops a waiting card's app after a while.

/** One pending timer per card: setting one clears the card's earlier one, and one that fired is gone. */
export class CardTimers {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Runs `fire` in `ms`, unless cleared or set again before. */
  set(cardId: string, ms: number, fire: () => unknown) {
    this.clear(cardId);
    this.timers.set(
      cardId,
      setTimeout(() => {
        this.timers.delete(cardId);
        void fire();
      }, ms),
    );
  }

  clear(cardId: string) {
    clearTimeout(this.timers.get(cardId));
    this.timers.delete(cardId);
  }

  /** Whether the card's timer is still to fire. */
  has(cardId: string): boolean {
    return this.timers.has(cardId);
  }

  clearAll() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
