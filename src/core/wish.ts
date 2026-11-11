// A wish or a bug for Obeya's makers, as a GitHub issue the owner opens prefilled in the browser
// and submits there under their own account: Obeya holds no token. The repository is fixed, since
// the app runs without a checkout whose `origin` could say otherwise.

/** Where the issue goes. */
export const ISSUES_REPO = 'sadilek/obeya';
const NEW_ISSUE = `https://github.com/${ISSUES_REPO}/issues/new`;

/** How long the link may get: GitHub and browsers take about 8 KB. */
export const MAX_ISSUE_URL = 8000;

/** What a draft starts from: the owner's words, and Obeya's answer when it said it cannot do what they asked. */
export interface Wish {
  said: string;
  answer?: string;
}

/** The line under the body: Obeya's version, the system, and how it runs. */
export const issueFooter = (version: string, os: string, runs: string) => `Obeya ${version} · ${os} · ${runs}`;
const FOOTER = /\n*Obeya \S+ · [^\n]+$/;

/** The body without its footer line, as the owner wrote or edited it. */
export const withoutFooter = (body: string) => body.replace(FOOTER, '').trimEnd();

/**
 * The link that opens the prefilled issue. A body too long for it is cut, with `note` at the cut
 * (the rest goes in by hand), and `trimmed` says so.
 */
export function issueUrl(title: string, body: string, note: string): { url: string; trimmed: boolean } {
  const url = (b: string) => `${NEW_ISSUE}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
  if (url(body).length <= MAX_ISSUE_URL) return { url: url(body), trimmed: false };
  const tail = `\n\n${note}`;
  // never half a character: a lone surrogate cannot be encoded
  const cut = (n: number) => body.slice(0, n).replace(/[\uD800-\uDBFF]$/, '');
  // the longest start of the body that fits, found by halving
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (url(cut(mid) + tail).length <= MAX_ISSUE_URL) lo = mid;
    else hi = mid - 1;
  }
  return { url: url(cut(lo).trimEnd() + tail), trimmed: true };
}
