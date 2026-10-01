// Inline markdown as plan docs use it: `code`, **bold**, _emphasis_, ~~strike~~, [links](url).

import type { ReactNode } from 'react';

const TOKEN = /`([^`]+)`|\*\*(.+?)\*\*|~~(.+?)~~|(?<![\w])_(.+?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function Inline({ md }: { md: string }) {
  return <>{render(md)}</>;
}

function render(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of md.matchAll(TOKEN)) {
    if (m.index > last) out.push(md.slice(last, m.index));
    const [, code, bold, strike, em, text, href] = m;
    if (code !== undefined) out.push(<code key={k++}>{code}</code>);
    else if (bold !== undefined) out.push(<b key={k++}>{render(bold)}</b>);
    else if (strike !== undefined) out.push(<s key={k++}>{render(strike)}</s>);
    else if (em !== undefined) out.push(<em key={k++}>{render(em)}</em>);
    else if (/^https?:/.test(href!)) out.push(<a key={k++} href={href} target="_blank" rel="noreferrer">{render(text!)}</a>);
    else out.push(<span key={k++}>{render(text!)}</span>);
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push(md.slice(last));
  return out;
}

/** A title from a longer text: its first sentence, cut at a word when that is still too long. */
export function shortTitle(md: string, max = 90): string {
  const text = plain(md).replace(/\s+/g, ' ').trim();
  // a sentence ends where the next one starts with a capital, so "z.B. betroffen" stays whole
  const first = (text.match(/^.+?[.!?;](?=\s+[A-ZÄÖÜ])/)?.[0] ?? text).replace(/[.;]$/, '');
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

/** Plain text for places that clamp or truncate. */
export function plain(md: string): string {
  return md.replace(TOKEN, (_, code, bold, strike, em, text) => code ?? bold ?? strike ?? em ?? text ?? '');
}

// ------------------------------------------------------------------ whole documents

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'code'; text: string }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'list'; list: List };
type List = { ordered: boolean; items: ListItem[] };
type ListItem = { text: string; mark: '' | 'open' | 'done'; children: List[] };

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Splits a markdown document into blocks: headings, paragraphs, lists, tables, quotes, code. */
export function blocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out: Block[] = [];
  let i = 0;
  const startsBlock = (l: string) => !l.trim() || FENCE.test(l) || HEADING.test(l) || RULE.test(l) || /^\s*>/.test(l) || /^\s*\|/.test(l) || LIST_ITEM.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
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
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', text: quote.join(' ').trim() });
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
        if (lines[i - 1]!.trim() && !startsBlock(l)) continue;
        break;
      }
      out.push({ t: 'list', list: parseList(lines.slice(start, i)) });
    } else {
      const para: string[] = [];
      for (; i < lines.length && (para.length === 0 || !startsBlock(lines[i]!)); i++) para.push(lines[i]!.trim());
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

/** A markdown document, as plan docs are written. `mark` highlights the item that starts with it (`W3`). */
export function Doc({ md, mark, markRef }: { md: string; mark?: string; markRef?: (el: HTMLElement | null) => void }) {
  const marked = mark ? new RegExp(`^\\*\\*${mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) : null;
  const list = (l: List, top: boolean): ReactNode => {
    const Tag = l.ordered ? 'ol' : 'ul';
    return (
      <Tag>
        {l.items.map((it, j) => {
          const hit = top && marked?.test(it.text);
          return (
            <li key={j} className={[it.mark, hit ? 'mark' : ''].filter(Boolean).join(' ') || undefined} ref={hit ? markRef : undefined}>
              <Inline md={it.text} />
              {it.children.map((c, k) => (
                <div key={k}>{list(c, false)}</div>
              ))}
            </li>
          );
        })}
      </Tag>
    );
  };
  return (
    <div className="doc">
      {blocks(md).map((b, i) => {
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
            return (
              <blockquote key={i}>
                <Inline md={b.text} />
              </blockquote>
            );
          case 'hr':
            return <hr key={i} />;
          case 'table':
            return (
              <div key={i} className="table">
                <table>
                  {b.head.length > 0 && (
                    <thead>
                      <tr>
                        {b.head.map((c, j) => (
                          <th key={j}>
                            <Inline md={c} />
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {b.rows.map((r, j) => (
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
              </div>
            );
          case 'list':
            return <div key={i}>{list(b.list, true)}</div>;
        }
      })}
    </div>
  );
}
