// Test doubles.

import type { AgentEvent, AgentRuntime, AgentSession, AgentSpec } from './runtime';

/** A session whose tools and events the test drives. */
export class FakeSession implements AgentSession {
  inbox: string[] = [];
  /** The images sent with each message of `inbox`, by index. */
  images: string[][] = [];
  closed = false;
  done: Promise<void>;
  private finish!: () => void;
  constructor(
    readonly spec: AgentSpec,
    first?: string,
    images: string[] = [],
  ) {
    if (first !== undefined) this.send(first, images);
    this.done = new Promise((r) => (this.finish = r));
  }
  send(text: string, images: string[] = []) {
    this.inbox.push(text);
    this.images.push(images);
  }
  close() {
    this.closed = true;
    this.finish();
  }
  call(name: string, args: Record<string, unknown>) {
    return this.spec.tools.find((t) => t.name === name)!.run(args);
  }
  emit(e: AgentEvent) {
    this.spec.onEvent(e);
  }
}

export class FakeRuntime implements AgentRuntime {
  sessions: FakeSession[] = [];
  start(spec: AgentSpec, first?: string, images?: string[]) {
    const s = new FakeSession(spec, first, images);
    this.sessions.push(s);
    return s;
  }
  get last() {
    return this.sessions.at(-1)!;
  }
}
