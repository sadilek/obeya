// Markdown as plain text, for places that clamp, truncate or search a text: shared by the canvas and
// the server, which searches the archive as the canvas shows it.

export const TOKEN = /`([^`]+)`|\*\*(.+?)\*\*(?!\*)|~~(.+?)~~|(?<![\w])_(.+?)_(?![\w])|(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w/])(https?:\/\/[^\s<>`"]+)|!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
export const FENCE = /^\s*(```|~~~)/;
export const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
export const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Plain text for places that clamp or truncate: without the marks of inline markdown nor those of
 * blocks (code fences, headings, list and quote marks, rules, a table's pipes). What a code block
 * holds stays as it is.
 */
export function plain(md: string): string {
  const out: string[] = [];
  let text: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (text.length) out.push(inlinePlain(text.join('\n')));
    text = [];
  };
  for (const line of md.split('\n')) {
    const open = FENCE.exec(line)?.[1];
    if (fence) {
      if (line.trim().startsWith(fence)) fence = undefined;
      else out.push(line);
    } else if (open) {
      flush();
      fence = open;
    } else if (!RULE.test(line) && !/^\s*\|[\s|:-]+$/.test(line)) text.push(blockPlain(line));
  }
  flush();
  return out.join('\n');
}

/**
 * A text on one line, for a card's excerpt: plain, its lines joined by a space after a sentence
 * that ends, else by a dot between them, as a heading or a list item does not end in one.
 */
export function excerpt(md: string): string {
  return plain(md)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .reduce((out, l) => (out ? `${out}${/[.!?:;…,]$/.test(out) ? ' ' : ' · '}${l}` : l), '');
}

/** A line of text without the marks that make it a heading, a quote, a list item or a table row. */
function blockPlain(line: string): string {
  const quoted = line.replace(/^(\s*>)+\s?/, '');
  const heading = HEADING.exec(quoted);
  if (heading) return heading[2]!;
  const item = LIST_ITEM.exec(quoted);
  if (item) return item[4]!;
  if (/^\s*\|/.test(quoted)) return quoted.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()).join(' · ');
  return quoted;
}

function inlinePlain(md: string): string {
  return md.replace(TOKEN, (_, code, bold, strike, em, star, text, _href, bare, alt) => code ?? bare ?? inlinePlain(bold ?? strike ?? em ?? star ?? text ?? alt ?? ''));
}
