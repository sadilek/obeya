// Reads a living plan doc (markdown) into a project and its workstreams.
//
// The shape follows the common template: a `# Title`, a `## Goal` section and a `## Workstreams`
// checklist whose top-level items are the workstreams (`- [x] **W3:** Title. Details …`).
// A doc without a workstream checklist is not a project (design notes, templates).

export interface PlanDoc {
  file: string;
  title: string;
  /** First paragraph of the goal section, inline markdown. */
  goal: string;
  workstreams: Workstream[];
}

export interface Workstream {
  /** Stable within the doc: the label, or `#n` for an unlabelled item. */
  key: string;
  label?: string;
  title: string;
  /** Everything after the title, inline markdown; sub-items on their own lines. */
  body: string;
  done: boolean;
  inReview: boolean;
}

const GOAL_HEADING = /^(goals?|ziele?)\b/i;
const WORKSTREAMS_HEADING = /^(workstreams?|arbeitspakete)\b/i;
const ITEM = /^- \[([ xX])\]\s+(.*)$/;
const LABEL = /^(W\d+[a-z]?(?:\.\d+)?|W[A-Z]{1,3})\b\s*(?:\(([^)]*)\))?\s*[:—–-]?\s*(.*)$/;

export function parsePlanDoc(file: string, markdown: string): PlanDoc | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const titleLine = lines.find((l) => l.startsWith('# '));
  const title = titleLine ? titleLine.slice(2).replace(/`/g, '').trim() : file;
  const sections = splitSections(lines);
  const goalSection = sections.find((s) => GOAL_HEADING.test(s.heading));
  const wsSection = sections.find((s) => WORKSTREAMS_HEADING.test(s.heading));
  if (!wsSection) return null;
  const workstreams = parseWorkstreams(wsSection.lines);
  if (!workstreams.length) return null;
  return { file, title, goal: goalSection ? firstParagraph(goalSection.lines) : '', workstreams };
}

function splitSections(lines: string[]) {
  const sections: { heading: string; lines: string[] }[] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) sections.push({ heading: line.slice(3).trim(), lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  return sections;
}

function firstParagraph(lines: string[]): string {
  const para: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (para.length) break;
      continue;
    }
    if (/^(>|\||#|<)/.test(t)) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  return para.join(' ');
}

function parseWorkstreams(lines: string[]): Workstream[] {
  // group each top-level checklist item with its indented continuation lines
  const raw: { done: boolean; lines: string[] }[] = [];
  let cur: { done: boolean; lines: string[] } | null = null;
  for (const line of lines) {
    const m = ITEM.exec(line);
    if (m) {
      cur = { done: m[1] !== ' ', lines: [m[2]!] };
      raw.push(cur);
    } else if (cur && /^\s+\S/.test(line)) cur.lines.push(line);
    else if (line.trim()) cur = null;
  }

  const seen = new Set<string>();
  return raw.map((r, i) => {
    // the first paragraph is the item's own text; indented sub-items follow on their own lines
    const firstSub = r.lines.findIndex((l, j) => j > 0 && /^\s+([-*+]|\d+\.)\s/.test(l));
    const own = (firstSub < 0 ? r.lines : r.lines.slice(0, firstSub)).map((l) => l.trim()).join(' ');
    // sub-items one per line; a wrapped line joins the item it continues
    const subs: string[] = [];
    for (const l of firstSub < 0 ? [] : r.lines.slice(firstSub)) {
      const line = l.replace(/^ {2}/, '').trimEnd();
      if (!subs.length || /^\s*([-*+]|\d+\.)\s/.test(line)) subs.push(line);
      else subs[subs.length - 1] += ' ' + line.trim();
    }
    const { label, note, title, rest } = splitItem(own);
    let key = label ?? `#${i + 1}`;
    for (let n = 2; seen.has(key); n++) key = `${label ?? `#${i + 1}`}~${n}`;
    seen.add(key);
    return {
      key,
      ...(label ? { label } : {}),
      title: capitalize(title),
      body: [rest, ...subs].filter(Boolean).join('\n'),
      done: r.done,
      inReview: /in review/i.test(note ?? ''),
    };
  });
}

function splitItem(text: string): { label?: string; note?: string; title: string; rest: string } {
  let bold: string | null = null;
  let after = text;
  if (text.startsWith('**')) {
    const end = text.indexOf('**', 2);
    if (end > 2) {
      bold = text.slice(2, end).trim();
      after = text.slice(end + 2).trim();
    }
  }
  if (bold !== null) {
    const m = LABEL.exec(bold);
    const label = m?.[1];
    const inBold = trimPunct(m ? m[3]! : bold);
    if (inBold) return { label, note: m?.[2], title: inBold, rest: stripLead(after) };
    return { label, note: m?.[2], ...cutTitle(after) };
  }
  return cutTitle(text);
}

/** Splits running text into a short title and the rest, at the first separator that ends a phrase. */
export function cutTitle(text: string): { title: string; rest: string } {
  let best = -1;
  let sepLen = 0;
  for (const sep of [' — ', ' – ', ': ', '; ', '. ']) {
    let from = 0;
    while (true) {
      const at = text.indexOf(sep, from);
      if (at < 0) break;
      from = at + 1;
      if (at < 3 || inCode(text, at)) continue;
      if (sep === '. ' && isAbbreviation(text.slice(0, at))) continue;
      if (best < 0 || at < best) {
        best = at;
        sepLen = sep.length;
      }
      break;
    }
  }
  if (best >= 0 && best <= 110) return { title: trimPunct(text.slice(0, best)), rest: text.slice(best + sepLen).trim() };
  if (text.length <= 90) return { title: trimPunct(text), rest: '' };
  const cut = text.lastIndexOf(' ', 80);
  return { title: text.slice(0, cut) + ' …', rest: '… ' + text.slice(cut + 1) };
}

function inCode(text: string, at: number): boolean {
  return (text.slice(0, at).match(/`/g)?.length ?? 0) % 2 === 1;
}

function isAbbreviation(before: string): boolean {
  const word = before.slice(before.lastIndexOf(' ') + 1);
  return word.length <= 2 || /^(bzw|ca|vs|e\.g|i\.e|inkl|ggf|usw|etc|Nr|Abs|Art)$/i.test(word);
}

const trimPunct = (s: string) => s.trim().replace(/[\s:.;,—–-]+$/, '').trim();
const stripLead = (s: string) => s.replace(/^[\s:.;,—–-]+/, '').trim();
const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
