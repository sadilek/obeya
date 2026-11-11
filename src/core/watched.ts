// Something others follow: they hear of each change and ask it what holds now.

/** Listeners told of a change; `onChange` returns what removes one. */
export class Listeners {
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  protected emit() {
    for (const fn of this.listeners) fn();
  }
}

/** A value its listeners hear of each time it changes; a value equal to the last as JSON is no change. */
export class Watched<T> extends Listeners {
  private last: T | null = null;

  current(): T | null {
    return this.last;
  }

  protected set(next: T | null) {
    if (JSON.stringify(next) === JSON.stringify(this.last)) return;
    this.last = next;
    this.emit();
  }
}
