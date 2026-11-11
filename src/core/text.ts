// Text cut to a length, for prompts, log lines and labels.

/** `s` cut to `n` characters, the last of them "…" when it was longer. */
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Why words an agent gave a tool for the owner are not shown, when they are longer than `n`
 * characters: cutting them would end them mid-sentence without the agent knowing, so it shortens them.
 */
export const tooLong = (s: string, n: number, call: string) =>
  s.length > n ? `Not shown: at ${s.length} characters this is longer than the ${n} the card shows. Shorten it (or split it over several calls), then call ${call} again.` : undefined;

/** `s` on one line: each run of whitespace one space. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** `s` on one line without Markdown's marks (`*`, `_`, `` ` ``, `#`, `>`). */
export const plainText = (s: string) => oneLine(s.replace(/[*_`#>]/g, ''));

/** What went wrong, from anything thrown. */
export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
