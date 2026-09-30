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

/** Plain text for places that clamp or truncate. */
export function plain(md: string): string {
  return md.replace(TOKEN, (_, code, bold, strike, em, text) => code ?? bold ?? strike ?? em ?? text ?? '');
}
