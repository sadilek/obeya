// Work given at most so long: what it comes to in time, else the caller goes on without it.

/** What `work` comes to, or undefined once `ms` have passed first. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** What `work` comes to; fails with `message` once `ms` have passed first. */
export async function withTimeout<T>(work: Promise<T>, ms: number, message = `no answer after ${ms / 1000} s`): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
