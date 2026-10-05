// Pages Obeya shows in a sandboxed frame (a worker's HTML artifact, an idea's mock): they tell the
// page around them their height, so the frame grows to it instead of scrolling inside.

/** The page's height, sent to the page around it whenever it changes: there the frame grows to it. */
const HEIGHT_REPORT = `<script>(() => {
  let last = 0;
  const say = () => {
    const h = document.documentElement.scrollHeight;
    if (Math.abs(h - last) > 2) { last = h; parent.postMessage({ obeyaHeight: h }, '*'); }
  };
  addEventListener('load', say);
  new ResizeObserver(say).observe(document.documentElement);
})();</script>`;

/** The page with its height report, at the end of its body (or of the page, without one). */
export function withHeightReport(html: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? html + HEIGHT_REPORT : html.slice(0, at) + HEIGHT_REPORT + html.slice(at);
}

/** A mock's few lines of HTML as a page of their own: a plain sans-serif on white unless the mock is a whole page itself. */
export function mockPage(html: string): string {
  const whole = /<html[\s>]/i.test(html);
  return withHeightReport(whole ? html : `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:8px;font:14px/1.4 system-ui,sans-serif;color:#222;background:#fff}</style></head><body>${html}</body></html>`);
}
