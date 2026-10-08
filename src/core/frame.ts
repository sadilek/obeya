// Pages Obeya shows in a sandboxed frame (a worker's HTML artifact, an idea's mock): they tell the
// page around them their height, so the frame grows to it instead of scrolling inside.

/**
 * The page's height, sent to the page around it whenever it changes, by a pixel too: there the
 * frame grows to it. Rounded up (scrollHeight rounds, and a page a fraction of a pixel higher than
 * its frame scrolls), and a page wider than its frame adds the scrollbar across its foot.
 */
const HEIGHT_REPORT = `<script>(() => {
  let last = 0;
  const say = () => {
    const html = document.documentElement;
    const h = Math.max(html.scrollHeight, Math.ceil(html.getBoundingClientRect().height)) + innerHeight - html.clientHeight;
    if (h !== last) { last = h; parent.postMessage({ obeyaHeight: h }, '*'); }
  };
  addEventListener('load', say);
  new ResizeObserver(say).observe(document.documentElement);
})();</script>`;

/** The page with its height report, at the end of its body (or of the page, without one). */
export function withHeightReport(html: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? html + HEIGHT_REPORT : html.slice(0, at) + HEIGHT_REPORT + html.slice(at);
}

/**
 * The height of a mock's content, not of its frame's window (that one only grows as the frame does):
 * a frame laid out narrow first shrinks back once it is wide.
 */
const CONTENT_HEIGHT_REPORT = `<script>(() => {
  let last = 0;
  const say = () => {
    const h = Math.ceil(document.body.getBoundingClientRect().height) + 16;
    if (Math.abs(h - last) > 2) { last = h; parent.postMessage({ obeyaHeight: h }, '*'); }
  };
  addEventListener('load', say);
  new ResizeObserver(say).observe(document.body);
})();</script>`;

/** A mock's few lines of HTML as a page of their own, in a plain sans-serif on white; a mock that is a whole page itself stays as it is. */
export function mockPage(html: string): string {
  if (/<html[\s>]/i.test(html)) return withHeightReport(html);
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:8px;display:flow-root;font:14px/1.4 system-ui,sans-serif;color:#222;background:#fff}</style></head><body>${html}${CONTENT_HEIGHT_REPORT}</body></html>`;
}
