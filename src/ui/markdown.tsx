// Inline markdown as plan docs use it: `code`, **bold**, *emphasis* and _emphasis_, ~~strike~~, [links](url),
// and bare web addresses, as agents write them in their messages; ![images](bild.png) where the
// document says where its images are served (`DocImages`), else their text.
// An asterisk opens emphasis only before a non-space and closes it only after one, so `5 * 3` and
// a list's `* ` stay as they are; neither may touch a word outside, so `a*b*c` stays too.

import { createContext, type ReactNode, useContext } from 'react';

const TOKEN = /`([^`]+)`|\*\*(.+?)\*\*(?!\*)|~~(.+?)~~|(?<![\w])_(.+?)_(?![\w])|(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w/])(https?:\/\/[^\s<>`"]+)|!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Where a document's images are served, by the address its markdown gives (`![…](bild.png)`); null
 * for one it does not serve. Without it an image shows as its text: a message or a plan doc loads
 * nothing from the web or the disk.
 */
export const DocImages = createContext<((src: string) => string | null) | null>(null);

/**
 * A bare address without what the sentence put after it: closing punctuation, and a parenthesis
 * that closes one opened before the address (Wikipedia's `…/Foo_(bar)` keeps its own).
 */
function bareUrl(s: string): string {
  for (;;) {
    const cut = s.replace(/[.,;:!?'*_\]]+$/, '');
    const unbalanced = cut.endsWith(')') && cut.split('(').length < cut.split(')').length;
    const next = unbalanced ? cut.slice(0, -1) : cut;
    if (next === s) return s;
    s = next;
  }
}

export function Inline({ md }: { md: string }) {
  return <>{render(md, false, useContext(DocImages))}</>;
}

/** `inLink`: the text of a link, where an address is only words, since a link holds no other; `image`: where images are served. */
function render(md: string, inLink = false, image: ((src: string) => string | null) | null = null): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of md.matchAll(TOKEN)) {
    if (m.index > last) out.push(md.slice(last, m.index));
    const [, code, bold, strike, em, star, text, href, bare, alt, src] = m;
    let end = m.index + m[0].length;
    if (code !== undefined) out.push(<code key={k++}>{code}</code>);
    else if (bold !== undefined) out.push(<b key={k++}>{render(bold, inLink, image)}</b>);
    else if (strike !== undefined) out.push(<s key={k++}>{render(strike, inLink, image)}</s>);
    else if (em !== undefined || star !== undefined) out.push(<em key={k++}>{render(em ?? star!, inLink, image)}</em>);
    else if (src !== undefined) {
      const url = image?.(src);
      out.push(url ? <img key={k++} className="doc-img" src={url} alt={alt} title={alt || undefined} /> : <span key={k++}>{alt}</span>);
    } else if (bare !== undefined) {
      const url = bareUrl(bare);
      end = m.index + url.length;
      // shown without its scheme, which says nothing in a sentence
      out.push(inLink ? url : <a key={k++} className="link" href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\/(www\.)?/, '')}</a>);
    } else if (/^https?:/.test(href!) && !inLink) out.push(<a key={k++} className="link" href={href} target="_blank" rel="noreferrer">{render(text!, true, image)}</a>);
    else out.push(<span key={k++}>{render(text!, inLink, image)}</span>);
    last = end;
  }
  if (last < md.length) out.push(md.slice(last));
  return out;
}

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

// ------------------------------------------------------------------ whole documents

export type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'code'; text: string }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'hr' }
  | { t: 'blank' }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'list'; list: List };
export type List = { ordered: boolean; items: ListItem[] };
type ListItem = { text: string; mark: '' | 'open' | 'done'; children: List[] };


/**
 * Splits a markdown document into blocks: headings, paragraphs, lists, tables, quotes, code. A quote
 * holds blocks of its own.
 * `breaks`: every line break ends a paragraph, which keeps the line's indentation, a line that is
 * not indented ends a list, and each blank line between blocks stays as one (`blank`), as in a chat
 * message; a document joins wrapped lines.
 */
export function blocks(md: string, { breaks = false } = {}): Block[] {
  const lines = md.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out: Block[] = [];
  let i = 0;
  const startsBlock = (l: string) => !l.trim() || FENCE.test(l) || HEADING.test(l) || RULE.test(l) || /^\s*>/.test(l) || /^\s*\|/.test(l) || LIST_ITEM.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      if (breaks && out.length && lines.slice(i + 1).some((l) => l.trim())) out.push({ t: 'blank' });
      i++;
    } else if (FENCE.test(line)) {
      const fence = FENCE.exec(line)![1]!;
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence); i++) code.push(lines[i]!);
      i++;
      out.push({ t: 'code', text: code.join('\n') });
    } else if (HEADING.test(line)) {
      const m = HEADING.exec(line)!;
      out.push({ t: 'h', level: m[1]!.length, text: m[2]! });
      i++;
    } else if (RULE.test(line)) {
      out.push({ t: 'hr' });
      i++;
    } else if (/^\s*>/.test(line)) {
      // a document's quote runs on through lazily continued lines of a paragraph
      const quote: string[] = [];
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        const prev = quote.at(-1);
        if (/^\s*>/.test(l)) quote.push(l.replace(/^\s*>\s?/, ''));
        else if (!breaks && prev?.trim() && !startsBlock(prev) && !startsBlock(l)) quote.push(l);
        else break;
      }
      out.push({ t: 'quote', blocks: blocks(quote.join('\n'), { breaks }) });
    } else if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]!); i++) rows.push(cells(lines[i]!));
      const sep = rows[1] && rows[1].every((c) => /^:?-+:?$/.test(c));
      out.push(sep ? { t: 'table', head: rows[0]!, rows: rows.slice(2) } : { t: 'table', head: [], rows });
    } else if (LIST_ITEM.test(line)) {
      const start = i;
      // a list runs on through indented and lazily continued lines, and across a blank line before
      // another item or an indented line
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        if (LIST_ITEM.test(l) || /^\s+\S/.test(l)) continue;
        if (!l.trim()) {
          const next = lines.slice(i + 1).find((x) => x.trim());
          if (next && (LIST_ITEM.test(next) || /^\s/.test(next))) continue;
          break;
        }
        if (!breaks && lines[i - 1]!.trim() && !startsBlock(l)) continue;
        break;
      }
      out.push({ t: 'list', list: parseList(lines.slice(start, i)) });
    } else {
      const para: string[] = [];
      for (; i < lines.length && (para.length === 0 || (!breaks && !startsBlock(lines[i]!))); i++) para.push(breaks ? lines[i]!.trimEnd() : lines[i]!.trim());
      out.push({ t: 'p', text: para.join(' ') });
    }
  }
  return out;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Nests list items by their indentation; a line that is no item continues the one before it. */
function parseList(lines: string[]): List {
  const root: List = { ordered: false, items: [] };
  const stack: { indent: number; list: List }[] = [];
  for (const line of lines) {
    const m = LIST_ITEM.exec(line);
    if (!m) {
      const last = stack.at(-1)?.list.items.at(-1);
      if (last && line.trim()) last.text += ' ' + line.trim();
      continue;
    }
    const indent = m[1]!.replace(/\t/g, '    ').length;
    const item: ListItem = { text: m[4]!, mark: m[3] === undefined ? '' : m[3] === ' ' ? 'open' : 'done', children: [] };
    while (stack.length && stack.at(-1)!.indent > indent) stack.pop();
    let top = stack.at(-1);
    if (!top || top.indent < indent) {
      const parent = top?.list.items.at(-1);
      const list: List = { ordered: /\d/.test(m[2]!), items: [] };
      if (parent) parent.children.push(list);
      else Object.assign(root, { ordered: list.ordered });
      top = { indent, list: parent ? list : root };
      stack.push(top);
    }
    top.list.items.push(item);
  }
  return root;
}

/**
 * A list with its sub-lists, ordered or not, open and done items marked. `mark` picks the top-level
 * item to highlight, `markRef` receives its element.
 */
export function ListTree({ list, className, mark, markRef }: { list: List; className?: string; mark?: (text: string) => boolean; markRef?: (el: HTMLElement | null) => void }) {
  const tree = (l: List, top: boolean): ReactNode => {
    const Tag = l.ordered ? 'ol' : 'ul';
    return (
      <Tag className={className}>
        {l.items.map((it, j) => {
          const hit = top && mark?.(it.text);
          return (
            <li key={j} className={[it.mark, hit ? 'mark' : ''].filter(Boolean).join(' ') || undefined} ref={hit ? markRef : undefined}>
              <Inline md={it.text} />
              {it.children.map((c, k) => (
                <div key={k}>{tree(c, false)}</div>
              ))}
            </li>
          );
        })}
      </Tag>
    );
  };
  return tree(list, true);
}

/** A table, with its header row when it has one. */
export function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table>
      {head.length > 0 && (
        <thead>
          <tr>
            {head.map((c, j) => (
              <th key={j}>
                <Inline md={c} />
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((r, j) => (
          <tr key={j}>
            {r.map((c, k) => (
              <td key={k}>
                <Inline md={c} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A markdown document, as plan docs are written. `mark` highlights the item that starts with it (`W3`). */
export function Doc({ md, mark, markRef }: { md: string; mark?: string; markRef?: (el: HTMLElement | null) => void }) {
  const marked = mark ? new RegExp(`^\\*\\*${mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) : null;
  const nodes = (bs: Block[]): ReactNode[] =>
    bs.map((b, i) => {
      switch (b.t) {
        case 'h': {
          const H = `h${Math.min(b.level + 1, 6)}` as 'h2';
          return (
            <H key={i}>
              <Inline md={b.text} />
            </H>
          );
        }
        case 'p':
          return (
            <p key={i}>
              <Inline md={b.text} />
            </p>
          );
        case 'code':
          return <pre key={i}>{b.text}</pre>;
        case 'quote':
          return <blockquote key={i}>{nodes(b.blocks)}</blockquote>;
        case 'hr':
          return <hr key={i} />;
        case 'blank':
          return null;
        case 'table':
          return (
            <div key={i} className="table">
              <Table head={b.head} rows={b.rows} />
            </div>
          );
        case 'list':
          return (
            <div key={i}>
              <ListTree list={b.list} mark={marked ? (text) => marked.test(text) : undefined} markRef={markRef} />
            </div>
          );
      }
    });
  return <div className="doc">{nodes(blocks(md))}</div>;
}

/**
 * Where in a markdown source a place in its rendered text lies: `offset` into the `nth` (from 0)
 * of the rendered text pieces that read `text`, found as the `nth` time `text` stands in the
 * source. The source's end where it does not stand there as rendered (an empty piece, say).
 */
export function sourceAt(md: string, text: string, nth: number, offset: number): number {
  if (!text) return md.length;
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = md.indexOf(text, at + 1);
    if (at < 0) return md.length;
  }
  return at + Math.min(offset, text.length);
}
