// "From idea to main" as a canvas: the four steps hang among other cards, and scrolling flies the
// camera from one to the next while the card in focus unfolds in place. Without JavaScript, on a
// small screen and with reduced motion the steps stay the plain list the CSS gives.
(() => {
  const section = document.getElementById('how');
  const flight = document.getElementById('flight');
  const view = flight.querySelector('.view');
  const world = flight.querySelector('.world');
  const stages = [...world.querySelectorAll('.step')].map((el) => ({
    el, x: +el.dataset.x, y: +el.dataset.y, w: +el.dataset.w, body: el.querySelector('.body'),
  }));
  const calm = matchMedia('(max-width: 900px), (prefers-reduced-motion: reduce)');
  const CLOSED_W = 260, PAD_BOTTOM = 18;
  const STEP = 0.9; // viewport heights of scrolling from one step to the next

  // the canvas around the steps, as it looks on a working day
  const CARDS = [
    [-680, -500, 's-working', 'Product', 'Search across canvases', 'Agent working'],
    [-420, -380, 's-approved', 'Product', 'Dark mode for settings', 'Approved'],
    [-680, -270, 's-planned', 'Product', 'Onboarding checklist', 'Planned'],
    [1300, -560, 's-waiting', 'Platform', 'Rate limit the public API', 'Demo ready'],
    [1560, -430, 's-working', 'Platform', 'Move jobs to a queue', 'Agent working'],
    [40, -300, 's-planned', 'Task', 'Fix login redirect', 'Planned'],
    [-560, 360, 's-working', 'Task', 'Fix flaky checkout test', 'Agent working'],
    [80, 520, 's-waiting', 'Task', 'VAT for EU customers', 'Question'],
    [1180, 780, 's-approved', 'Task', 'Health check endpoint', 'Approved'],
    [1760, 420, 's-planned', 'Task', 'Upgrade Postgres to 17', 'Planned'],
    [-300, 860, 's-idea', 'Idea', 'Yearly plans with a discount', 'Idea'],
    [300, 1040, 's-approved', 'Task', 'Faster cold start', 'Approved'],
  ];
  const TERRITORIES = [
    [-720, -560, 590, 420, 'var(--blue)', 'Product'],
    [1260, -620, 620, 340, 'var(--green)', 'Platform'],
  ];
  const deco = [];
  for (const [x, y, w, h, c, label] of TERRITORIES) {
    const t = document.createElement('div');
    t.className = 'territory';
    t.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;--c:${c}`;
    t.innerHTML = `<span>${label}</span>`;
    deco.push(t);
  }
  for (const [x, y, state, kind, title, label] of CARDS) {
    const d = document.createElement('div');
    d.className = `card deco ${state}`;
    d.style.cssText = `left:${x}px;top:${y}px`;
    d.innerHTML = `<div class="kind">${kind}</div><div class="ttl">${title}</div><span class="state"><i></i>${label}</span>`;
    deco.push(d);
  }
  for (const d of deco) d.setAttribute('aria-hidden', 'true');

  const progress = document.createElement('ol');
  progress.className = 'progress';
  progress.setAttribute('aria-hidden', 'true');
  stages.forEach((s, n) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#how';
    a.tabIndex = -1;
    a.className = s.el.className.match(/s-\w+/)[0];
    a.innerHTML = `<span>${s.el.querySelector('h3').textContent}</span>`;
    a.addEventListener('click', (e) => { e.preventDefault(); go(n); });
    li.append(a);
    progress.append(li);
    s.dot = a;
  });

  const clamp = (v) => Math.max(0, Math.min(1, v));
  const ease = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;

  // each step's height folded (at the closed width) and unfolded (at its own width)
  function measure() {
    for (const s of stages) {
      s.el.style.left = `${s.x}px`; s.el.style.top = `${s.y}px`; s.el.style.height = 'auto';
      s.el.style.width = `${CLOSED_W}px`;
      s.hc = s.el.offsetHeight;
      s.el.style.width = `${s.w}px`;
      s.body.style.width = `${s.w - 24 - 18}px`;
      s.body.style.top = `${s.el.offsetHeight - PAD_BOTTOM}px`;
      s.h = s.el.offsetHeight + s.body.offsetHeight + 4;
    }
    flight.style.height = `${innerHeight * (1 + (stages.length - 1) * STEP + 0.4)}px`;
  }

  const size = (s, o) => [lerp(CLOSED_W, s.w, o), lerp(s.hc, s.h, o)];
  const centre = (s, o) => { const [w, h] = size(s, o); return [s.x + w / 2, s.y + h / 2]; };
  const zoomFor = (s) => Math.min(1.2, (innerWidth * 0.36) / s.w, (innerHeight * 0.6) / s.h);
  const progressNow = () => Math.min(stages.length - 1, Math.max(0, -flight.getBoundingClientRect().top / (STEP * innerHeight)));

  function frame() {
    const p = progressNow();
    const i = Math.min(stages.length - 2, Math.floor(p));
    const t = p - i;
    const a = stages[i], b = stages[i + 1];
    // hold, fold, fly, unfold
    const openA = 1 - ease(clamp((t - 0.1) / 0.25));
    const fly = ease(clamp((t - 0.2) / 0.6));
    const openB = ease(clamp((t - 0.65) / 0.25));
    for (const s of stages) s.open = s === a ? openA : s === b ? openB : 0;

    const [ax, ay] = centre(a, openA), [bx, by] = centre(b, openB);
    const cx = lerp(ax, bx, fly), cy = lerp(ay, by, fly);
    // a flight rises over the canvas and comes down on the next card
    const dist = Math.hypot(bx - ax, by - ay);
    const rise = 1 - Math.min(0.6, dist / 1500) * Math.sin(Math.PI * fly);
    const z = Math.exp(lerp(Math.log(zoomFor(a)), Math.log(zoomFor(b)), fly)) * rise;
    const vw = view.clientWidth, vh = view.clientHeight;
    const tx = vw / 2 - cx * z, ty = vh / 2 - cy * z;
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    view.style.backgroundPosition = `${tx}px ${ty}px`;
    view.style.backgroundSize = `${22 * z}px ${22 * z}px`;

    for (const s of stages) {
      const [w, h] = size(s, s.open);
      s.el.style.width = `${w}px`; s.el.style.height = `${h}px`;
      s.body.style.opacity = clamp((s.open - 0.55) / 0.45);
      s.el.classList.toggle('focus', s.open > 0.5);
      s.el.style.zIndex = s.open > 0 ? 3 : 2;
    }
    const near = Math.round(p);
    stages.forEach((s, n) => s.dot.classList.toggle('on', n === near));
  }

  function go(n) {
    const top = flight.getBoundingClientRect().top + scrollY + n * STEP * innerHeight;
    scrollTo({ top, behavior: 'smooth' });
  }

  let queued = false;
  const request = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; frame(); }); } };
  // a scroll that stops between two steps settles on the nearer one
  let settle;
  const onScroll = () => {
    request();
    clearTimeout(settle);
    settle = setTimeout(() => {
      const r = flight.getBoundingClientRect();
      if (r.top > 0 || r.bottom < innerHeight) return;
      const p = progressNow(), n = Math.round(p);
      if (Math.abs(p - n) > 0.02) go(n);
    }, 200);
  };
  const onResize = () => { measure(); request(); };

  function on() {
    section.classList.add('fly');
    world.prepend(...deco);
    view.append(progress);
    measure(); frame();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onResize);
  }
  function off() {
    section.classList.remove('fly');
    for (const d of deco) d.remove();
    progress.remove();
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', onResize);
    for (const el of [flight, view, world, ...stages.flatMap((s) => [s.el, s.body])]) el.removeAttribute('style');
    for (const s of stages) s.el.classList.remove('focus');
  }

  if (!calm.matches) on();
  calm.addEventListener('change', () => (calm.matches ? off() : on()));
  document.fonts.ready.then(() => { if (!calm.matches) onResize(); });
})();
