// Reads a living plan doc (markdown) into a project and its workstreams.
//
// The shape follows the common template: a `# Title`, a `## Goal` section and a `## Workstreams`
// checklist whose top-level items are the workstreams (`- [x] **W3:** Title. Details …`).
// A doc without a workstream checklist is not a project (design notes, templates); the parse says
// why, for the owner to see.

export interface PlanDoc {
  file: string;
  title: string;
  /** First paragraph of the goal section, inline markdown. */
  goal: string;
  workstreams: Workstream[];
  /** The doc as written, for the owner to read. */
  markdown: string;
}

export interface Workstream {
  /**
   * Who the workstream is, whatever its place in the doc: the label, else its title as a slug (a
   * pull request's number before it aside); `#n` only for an item whose title has no letter or digit.
   */
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
// `W3`, `W3a`, `W1.2`, `WP`, and the short codes other docs use (`S1:`, `A1 —`, `1G.`)
const CODE = String.raw`(?:[A-Z]{1,3}\d+[a-z]?(?:\.\d+)?|\d+[A-Z])`;
const AFTER_LABEL = String.raw`\s*(?:\(([^)]*)\))?\s*[:.—–-]?\s*(.*)$`;
const LABEL = new RegExp(String.raw`^((?:W\d+[a-z]?(?:\.\d+)?|W[A-Z]{1,3})\b|${CODE}(?=$|\s*[:—–(]|\.(?:\s|$)))${AFTER_LABEL}`);
// a code before a space alone (`4A Title`) is a label where the doc's items use codes, not in a title of its own (`K8s Cluster`)
const SPACED_LABEL = new RegExp(String.raw`^(${CODE})(?=\s)${AFTER_LABEL}`);
const SPACED_CODE = new RegExp(String.raw`^\*\*${CODE}\s`);

/** Why a doc in the plan directory is not a project: no `## Workstreams` section, or one without a checklist. */
export type NotAProject = 'noWorkstreams' | 'noChecklist';

/** A doc in the plan directory that is not a project, with the reason. */
export interface OtherDoc {
  file: string;
  reason: NotAProject;
}

/** Every workstream is ticked: the project's work is done, and it ends. */
export const allTicked = (doc: PlanDoc): boolean => doc.workstreams.every((w) => w.done);

/** The project the doc describes, or why it is none. */
export function parsePlanDoc(file: string, markdown: string): PlanDoc | OtherDoc {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const titleLine = lines.find((l) => l.startsWith('# '));
  const title = titleLine ? titleLine.slice(2).replace(/`/g, '').trim() : file;
  const sections = splitSections(lines);
  const goalSection = sections.find((s) => GOAL_HEADING.test(s.heading));
  const wsSection = sections.find((s) => WORKSTREAMS_HEADING.test(s.heading));
  if (!wsSection) return { file, reason: 'noWorkstreams' };
  const workstreams = parseWorkstreams(wsSection.lines);
  if (!workstreams.length) return { file, reason: 'noChecklist' };
  return { file, title, goal: goalSection ? firstParagraph(goalSection.lines) : '', workstreams, markdown };
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

  const spaced = raw.filter((r) => SPACED_CODE.test(r.lines[0]!)).length >= 2;
  const items = raw.map((r) => {
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
    const { label, note, title, rest } = splitItem(own, spaced);
    return { r, label, note, title, rest, subs };
  });
  // a label the doc gives twice tells its items apart by their titles, not by their order
  const twice = new Set(items.flatMap((x, i) => (x.label && items.findIndex((y) => y.label === x.label) !== i ? [x.label] : [])));
  const seen = new Set<string>();
  return items.map(({ r, label, note, title, rest, subs }, i) => {
    const base = label ? (twice.has(label) ? `${label}~${titleKey(title)}` : label) : titleKey(title) || `#${i + 1}`;
    let key = base;
    for (let n = 2; seen.has(key); n++) key = `${base}~${n}`;
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

function splitItem(text: string, spaced: boolean): { label?: string; note?: string; title: string; rest: string } {
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
    const m = LABEL.exec(bold) ?? (spaced ? SPACED_LABEL.exec(bold) : null);
    const label = m?.[1];
    const inBold = trimPunct(m ? m[3]! : bold);
    // a pull request's number alone is no title: the text after it goes with it
    if (inBold && isReference(inBold)) return { label, note: m?.[2], ...cutTitle(`${(m ? m[3]! : bold).trim()} ${after}`) };
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
      if (isReference(text.slice(0, at))) continue;
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

/** A pull request or issue by its number (`#12`, `PR #12`, `(#12)`, `!12`, a link on one), as an agent puts it before what it did. */
const isReference = (text: string): boolean =>
  /^\(?(?:(?:PR|MR|pull request|issue)\s+)?(?:[#!]\d+|\[(?:(?:PR|MR)\s+)?[#!]\d+\]\([^)\s]+\))\)?$/i.test(text.trim());

/** The title without the pull request's number a worker may put before it (`#12. Title` → `Title`). */
export const withoutReference = (title: string): string =>
  title.replace(/^\(?(?:(?:PR|MR|pull request|issue)\s+)?(?:[#!]\d+|\[(?:(?:PR|MR)\s+)?[#!]\d+\]\([^)\s]+\))\)?[\s.:;,—–-]*/i, '');

/**
 * An unlabelled workstream's key: its title in lower-case words joined by `-`, without a pull
 * request's number a worker may put before it when ticking it off.
 */
export function titleKey(title: string): string {
  return withoutReference(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
}

const SPACED_TITLE = new RegExp(String.raw`^(${CODE})\s+(.*)$`);

/**
 * Every key the workstream would have in another version of its doc where only the other items
 * differ: with or without its code read as a label (`4A Title` alone in a doc is a title), and with
 * or without its title after a label the doc gives twice (`W1~upload`).
 */
export function workstreamAliases(w: Pick<Workstream, 'label' | 'title'>, titled = false): string[] {
  const spaced = w.label ? null : SPACED_TITLE.exec(w.title);
  const label = w.label ?? spaced?.[1];
  const title = w.label ? w.title : spaced?.[2];
  // `titled`: only the keys that name the title too, which a label alone does not
  const keys = [titleKey(w.label ? `${w.label} ${w.title}` : w.title), ...(label ? [...(titled ? [] : [label]), `${label}~${titleKey(title!)}`] : [])];
  return [...new Set(keys.filter((k) => k && !k.endsWith('~')))];
}

const trimPunct = (s: string) => s.trim().replace(/[\s:.;,—–-]+$/, '').trim();
const stripLead = (s: string) => s.replace(/^[\s:.;,—–-]+/, '').trim();
const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
