// Injected into every page of a demo recording. Headless Chrome paints no mouse pointer and no
// focus cues a viewer could follow, so the recording carries its own: a pointer that glides to
// each target, a click ripple, highlight rings that track their elements through scrolling, and
// an image stage for things the page itself cannot show (a PDF, a rendered e-mail), a white
// veil over a time jump, a stretch the video leaves out, and a clock strip (`CLOCK`).
(() => {
  if (window.__demo) return;
  // The time each frame was painted, in a strip of black and white cells at the bottom left: on a
  // busy machine the screencast hands frames over seconds after they were painted, so the director
  // reads the time from the picture (`readClock` in timeline.ts) and paints the strip over in the video.
  const CLOCK = { bits: 24, cell: 3, left: 2, bottom: 3 };
  const strip = document.createElement('canvas');
  strip.width = CLOCK.bits * CLOCK.cell;
  strip.height = CLOCK.cell;
  strip.style.cssText =
    `position:fixed;left:${CLOCK.left}px;bottom:${CLOCK.bottom}px;width:${strip.width}px;height:${strip.height}px;` +
    'pointer-events:none;z-index:2147483647;image-rendering:pixelated;';
  const pen = strip.getContext('2d');
  function tick() {
    if (!strip.isConnected && document.documentElement) document.documentElement.appendChild(strip);
    // hundredths of a second, the low 24 bits: unique over 46 hours
    const code = Math.floor(Date.now() / 10) % 2 ** CLOCK.bits;
    for (let i = 0; i < CLOCK.bits; i++) {
      pen.fillStyle = (code >> (CLOCK.bits - 1 - i)) & 1 ? '#000' : '#fff';
      pen.fillRect(i * CLOCK.cell, 0, CLOCK.cell, CLOCK.cell);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  const ACCENT = '#f5a524';
  let root = null;
  let cursor = null;
  let rings = [];
  let dim = null;
  let stage = null;
  let veil = null;
  let pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    cursor = document.createElement('div');
    cursor.innerHTML =
      '<svg width="26" height="30" viewBox="0 0 26 30"><path d="M3 2 L3 24 L9 18.5 L13.5 28 L17.5 26.2 L13 17 L21 17 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
    cursor.style.cssText =
      'position:absolute;left:0;top:0;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));' +
      'transition:transform 700ms cubic-bezier(.45,0,.2,1);will-change:transform;';
    cursor.style.transform = `translate(${pointer.x}px,${pointer.y}px)`;
    root.appendChild(cursor);
    document.documentElement.appendChild(root);
    requestAnimationFrame(track);
    return root;
  }

  function unionRect(elements) {
    const rects = elements.filter((e) => e && e.isConnected).map((e) => e.getBoundingClientRect());
    if (!rects.length) return null;
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return { left, top, width: right - left, height: bottom - top };
  }

  // One layer dims the page for all rings together, with a hole in its mask for each ring: a
  // dimming shadow on every ring would lay itself over the other rings' elements.
  const SVG = 'http://www.w3.org/2000/svg';
  function ensureDim() {
    if (dim && dim.svg.isConnected) return dim;
    const svg = document.createElementNS(SVG, 'svg');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity 300ms ease;';
    const id = `demo-dim-${Math.random().toString(36).slice(2)}`;
    svg.innerHTML =
      `<mask id="${id}"><rect width="100%" height="100%" fill="#fff"/></mask>` +
      `<rect width="100%" height="100%" fill="rgb(15,23,42)" fill-opacity=".18" mask="url(#${id})"/>`;
    root.insertBefore(svg, root.firstChild);
    requestAnimationFrame(() => (svg.style.opacity = '1'));
    dim = { svg, mask: svg.querySelector('mask') };
    return dim;
  }

  function track() {
    for (const ring of rings) {
      const r = unionRect(ring.elements);
      // A ring whose element is gone (a closed dialog) must not linger over whatever is there now.
      ring.box.style.display = r ? '' : 'none';
      ring.hole.style.display = r ? '' : 'none';
      if (!r) continue;
      const pad = 6;
      Object.assign(ring.box.style, {
        left: `${r.left - pad}px`,
        top: `${r.top - pad}px`,
        width: `${r.width + 2 * pad}px`,
        height: `${r.height + 2 * pad}px`,
      });
      // the hole spans the ring's border too, as the shadow used to
      const border = 3;
      ring.hole.setAttribute('x', r.left - pad);
      ring.hole.setAttribute('y', r.top - pad);
      ring.hole.setAttribute('width', r.width + 2 * (pad + border));
      ring.hole.setAttribute('height', r.height + 2 * (pad + border));
    }
    // A label sits above its ring unless that covers another ring; then it goes below.
    for (const ring of rings) {
      if (!ring.tag) continue;
      const box = ring.box.getBoundingClientRect();
      const h = ring.tag.offsetHeight + 8;
      const above = { top: box.top - h, bottom: box.top };
      const covers = rings.some((other) => {
        if (other === ring) return false;
        const o = other.box.getBoundingClientRect();
        return o.top < above.bottom && o.bottom > above.top;
      });
      ring.tag.style.bottom = covers ? '' : 'calc(100% + 8px)';
      ring.tag.style.top = covers ? 'calc(100% + 8px)' : '';
    }
    requestAnimationFrame(track);
  }

  window.__demo = {
    moveTo(x, y, instant = false) {
      ensureRoot();
      pointer = { x, y };
      // a drag moves the pointer in small steps, each of which it follows at once
      cursor.style.transition = instant ? 'none' : 'transform 700ms cubic-bezier(.45,0,.2,1)';
      cursor.style.transform = `translate(${x - 3}px,${y - 2}px)`;
    },
    ripple() {
      ensureRoot();
      const dot = document.createElement('div');
      dot.style.cssText =
        `position:absolute;left:${pointer.x - 22}px;top:${pointer.y - 22}px;width:44px;height:44px;` +
        `border-radius:50%;background:${ACCENT};opacity:.55;transform:scale(.2);` +
        'transition:transform 450ms ease-out,opacity 450ms ease-out;';
      root.insertBefore(dot, cursor);
      requestAnimationFrame(() => {
        dot.style.transform = 'scale(1)';
        dot.style.opacity = '0';
      });
      setTimeout(() => dot.remove(), 600);
    },
    highlight(elements, label) {
      ensureRoot();
      const box = document.createElement('div');
      box.style.cssText =
        `position:absolute;border:3px solid ${ACCENT};border-radius:12px;` +
        'box-shadow:0 0 18px rgba(245,165,36,.55);' +
        'opacity:0;transition:opacity 300ms ease;';
      let tag = null;
      if (label) {
        tag = document.createElement('div');
        tag.textContent = label;
        tag.style.cssText =
          `position:absolute;left:-3px;bottom:calc(100% + 8px);background:${ACCENT};color:#111;` +
          'font:600 15px/1.2 system-ui,sans-serif;padding:6px 10px;border-radius:8px;white-space:nowrap;';
        box.appendChild(tag);
      }
      root.insertBefore(box, cursor);
      const hole = document.createElementNS(SVG, 'rect');
      hole.setAttribute('rx', '12');
      hole.setAttribute('fill', '#000');
      hole.style.cssText = 'opacity:0;transition:opacity 300ms ease;';
      ensureDim().mask.appendChild(hole);
      rings.push({ box, elements, tag, hole });
      requestAnimationFrame(() => {
        box.style.opacity = '1';
        hole.style.opacity = '1';
      });
    },
    clearHighlights() {
      for (const ring of rings) ring.box.remove();
      rings = [];
      if (dim) dim.svg.remove();
      dim = null;
    },
    showImage(src, top, caption) {
      ensureRoot();
      this.hideImage();
      stage = document.createElement('div');
      stage.style.cssText =
        'position:absolute;inset:0;background:rgba(15,23,42,.72);overflow:hidden;' +
        'opacity:0;transition:opacity 350ms ease;';
      const img = document.createElement('img');
      img.src = src;
      const width = Math.min(1000, window.innerWidth - 120);
      img.style.cssText =
        `position:absolute;left:50%;top:40px;width:${width}px;margin-left:${-width / 2}px;` +
        'border-radius:6px;box-shadow:0 20px 60px rgba(0,0,0,.5);background:#fff;' +
        'transition:transform 1200ms cubic-bezier(.45,0,.2,1);';
      stage.appendChild(img);
      if (caption) {
        const cap = document.createElement('div');
        cap.textContent = caption;
        cap.style.cssText =
          'position:absolute;left:24px;top:24px;background:#111;color:#fff;border-radius:8px;' +
          'font:600 15px/1.2 system-ui,sans-serif;padding:8px 12px;z-index:1;';
        stage.appendChild(cap);
      }
      root.insertBefore(stage, cursor);
      const place = () => {
        stage.dataset.ready = '1';
        this.panImage(top);
      };
      img.complete ? place() : (img.onload = place);
      requestAnimationFrame(() => (stage.style.opacity = '1'));
    },
    panImage(top) {
      if (!stage) return;
      const img = stage.querySelector('img');
      img.style.transform = `translateY(${-top * img.getBoundingClientRect().height}px)`;
    },
    hideImage() {
      if (stage) stage.remove();
      stage = null;
    },
    // A time jump: the page fades to white, the cut falls while it is white, and it fades back
    // in with how much later it is.
    whiteOut() {
      ensureRoot();
      if (veil) veil.remove();
      veil = document.createElement('div');
      veil.style.cssText =
        'position:absolute;inset:0;background:#fff;display:grid;place-items:center;' +
        'color:#57534e;font:600 30px/1.2 system-ui,sans-serif;opacity:0;transition:opacity 250ms ease-in;';
      root.appendChild(veil);
      requestAnimationFrame(() => (veil.style.opacity = '1'));
    },
    timeJump(label) {
      // A page that reloaded while it was white has lost its veil: it comes back without a fade.
      if (!veil || !veil.isConnected) {
        this.whiteOut();
        veil.style.transition = 'none';
        veil.style.opacity = '1';
      }
      veil.textContent = label;
    },
    whiteIn() {
      if (!veil) return;
      const v = veil;
      veil = null;
      v.style.transition = 'opacity 400ms ease-out';
      v.style.opacity = '0';
      setTimeout(() => v.remove(), 450);
    },
  };
})();
