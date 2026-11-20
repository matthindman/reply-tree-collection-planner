/* cascades.js — the cascade view: controls, verdict and figures. Arithmetic is in cascade_model.js.
   To change a default or a label, edit DEFAULTS and GROUPS below, then run build.py. */
(function () {
  'use strict';
  const U = PLANNER.ui, D = CASCADE.DATA, el = U.el, frame = U.frame, lin = U.lin, logS = U.logS, logTicks = U.logTicks, path = U.path, legend = U.legend, row = U.row, big = U.big, pct = U.pct, int = U.int;

  /* ====================================================================== defaults */
  // Sizes come from CASCADE.DATA (cascade_model.js): counts for September 2026 on the full Japanese stream.
  const DEFAULTS = {
    cap: 1e8,            // units a month
    reserve: 1e7,        // kept back for daily spikes, the largest cascades and lookups
    window: 3,           // days after the root is posted
    month: 'September',  // which measured month the volumes follow
    change: 0,           // change in volume since that month (a 31-day month alone is +3%)
    rt: 0.85,            // retweets as a share of posts (measured as 80 to 89%)
    qt: 0.05,            // quotes as a share of posts (measured as about 5%)
    quoteRooted: true,   // count cascades rooted at a quote as well
    full: 10000,         // tier 1: every post, for cascades of at least this many posts
    rqAuto: true, rq: 2500,   // tier 2: replies and quotes; rqAuto sets rq to the lowest size that fits
    rtMode: 'none', rtN: 100, rtRate: 0.03,   // retweets bought for tier 2
    census: 100, passes: 3,   // tier 3: the root and its counts; the last pass is at the end of the window
    stream: 0.01,        // the sample stream, outside the cap
  };
  const TIER = { full: 'var(--quiet)', rq: 'var(--root)', bought: 'var(--sample)', census: 'var(--both)', reserve: 'var(--ref)' };
  const KIND = ['var(--root)', 'var(--sample)', 'var(--both)'];
  let st = JSON.parse(JSON.stringify(DEFAULTS)), pop = null;
  const sz = (v) => int(v) + ' posts';

  const GROUPS = [
    { title: 'The contract', controls: [
      { key: 'cap', kind: 'log', label: 'Monthly cap, in units', min: 1e7, max: 1e9, fmt: big, hint: 'One unit is the charge for one post returned.' },
      { key: 'reserve', kind: 'range', label: 'Kept in reserve', min: 0, max: 3e7, step: 1e6, fmt: (v) => (v ? big(v) : 'none'), hint: 'For daily spikes, the largest cascades and lookups.' },
      { key: 'window', kind: 'seg', label: 'Window after the root is posted', options: [[1, '1 day'], [2, '2 days'], [3, '3 days'], [7, '7 days']], hint: 'Posts after the window are not collected. One and two days are estimates: no post totals were measured for them.' },
    ] },
    { title: 'Volumes', controls: [
      { key: 'month', kind: 'seg', label: 'A month like, in 2026', options: [['June', 'Jun'], ['July', 'Jul'], ['August', 'Aug'], ['September', 'Sep']], hint: 'Sizes were measured for September, the largest of the four. The others scale it by their total.' },
      { key: 'change', kind: 'range', label: 'Change in volume since then', min: -0.2, max: 0.5, step: 0.01, fmt: (v) => (v > 0 ? '+' : '') + Math.round(100 * v) + '%', hint: 'Volumes rose about 8% a month from July to September. A 31-day month adds 3%.' },
      { key: 'rt', kind: 'range', label: 'Retweets, as a share of posts', min: 0.78, max: 0.91, step: 0.01, fmt: (v) => Math.round(100 * v) + '%', hint: 'Measured as 80 to 89%. Quotes are taken as 5% and replies as the rest.' },
      { key: 'quoteRooted', kind: 'check', label: 'Count cascades rooted at a quote', hint: 'Their posts are measured, as lower bounds. Their number is estimated.' },
      { kind: 'facts', id: 'c-facts' },
    ] },
    { title: 'What to collect', controls: [
      { key: 'full', kind: 'pick', label: 'Every post, for cascades of at least', choices: [5000, 6000, 7500, 10000, 12500, 15000, 20000, 30000, 50000, Infinity], fmt: (v) => (v === Infinity ? 'no cascade' : sz(v)) },
      { key: 'rqAuto', kind: 'check', label: 'Take replies and quotes as low as fits' },
      { key: 'rq', kind: 'log', label: 'Replies and quotes, for cascades of at least', min: 100, max: 20000, fmt: sz, disabled: () => st.rqAuto,
        hint: 'Below 1,000 posts the sizes are rough.' },
      { key: 'rtMode', kind: 'seg', label: 'Retweets for those cascades', options: [['none', 'Stream only'], ['first', 'First N'], ['sample', 'Sample']],
        hint: 'The 1% stream shows a random 1% of retweets at no cost. First N and Sample buy more.' },
      { key: 'rtN', kind: 'pick', label: 'Retweets read from each cascade', choices: [50, 100, 250, 500, 1000], fmt: (v) => 'first ' + int(v), disabled: () => st.rtMode !== 'first' },
      { key: 'rtRate', kind: 'range', label: 'Random share of retweets bought', min: 0.01, max: 0.3, step: 0.01, fmt: (v) => Math.round(100 * v) + '%', disabled: () => st.rtMode !== 'sample' },
      { key: 'census', kind: 'pick', label: 'Root and counts, for cascades of at least', choices: [100, 200, 300, 500, 1000], fmt: sz,
        hint: 'Search filters on a root’s own retweet or reply count. How well that matches a cascade’s size has not been measured.' },
      { key: 'passes', kind: 'range', label: 'Search passes for each day of roots', min: 1, max: 3, step: 1, fmt: (v) => { const n = Math.min(v, st.window); return n === 1 ? 'once' : n === 2 ? 'twice' : '3 times'; }, hint: 'The last pass is at the end of the window, earlier ones at 24 and 48 hours, so a one-day window has one pass. Each pass returns every root again.' },
    ] },
  ];

  /* ====================================================================== controls */
  const rail = document.getElementById('c-rail'), refreshers = [];
  function build() {
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    GROUPS.forEach((g) => {
      const sec = mk('section', 'group'); sec.appendChild(mk('h2', null, g.title));
      g.controls.forEach((c) => {
        if (c.kind === 'facts') { const dl = mk('dl', 'facts'); dl.id = c.id; sec.appendChild(dl); return; }
        const wrap = mk('div', 'ctl'), head = mk('div', 'ctl-head'), isSlider = c.kind === 'range' || c.kind === 'log' || c.kind === 'pick';
        if (c.kind === 'check') {
          const s = mk('div', 'checks'), l = mk('label'), i = mk('input'); i.type = 'checkbox'; i.id = 'cc-' + c.key;
          i.addEventListener('change', () => { st[c.key] = i.checked; changed(); });
          l.appendChild(i); l.appendChild(document.createTextNode(c.label)); s.appendChild(l); wrap.appendChild(s);
          refreshers.push(() => { i.checked = st[c.key]; });
        } else {
          const lab = mk(isSlider ? 'label' : 'span', 'lab', c.label), val = mk('span', 'val'); head.appendChild(lab); head.appendChild(val); wrap.appendChild(head);
          if (isSlider) {
            const r = mk('input'); r.type = 'range'; r.id = 'cc-' + c.key; lab.htmlFor = r.id;
            if (c.kind === 'range') { r.min = c.min; r.max = c.max; r.step = c.step; } else if (c.kind === 'log') { r.min = 0; r.max = 400; r.step = 1; } else { r.min = 0; r.max = c.choices.length - 1; r.step = 1; }
            const toState = (x) => c.kind === 'range' ? +x : c.kind === 'log' ? +(c.min * Math.pow(c.max / c.min, x / 400)).toPrecision(3) : c.choices[+x];
            const fromState = (v) => c.kind === 'range' ? v : c.kind === 'log' ? Math.round(400 * Math.log(v / c.min) / Math.log(c.max / c.min)) : Math.max(0, c.choices.indexOf(v));
            r.addEventListener('input', () => { st[c.key] = toState(r.value); changed(); });
            wrap.appendChild(r);
            refreshers.push(() => { r.value = fromState(st[c.key]); val.textContent = c.fmt(st[c.key]); r.disabled = c.disabled ? c.disabled() : false; });
          } else {
            const s = mk('div', 'seg'); s.setAttribute('role', 'group'); s.setAttribute('aria-label', c.label);
            const btns = c.options.map(([v, t]) => { const b = mk('button', null, t); b.type = 'button'; b.addEventListener('click', () => { st[c.key] = v; changed(); }); s.appendChild(b); return [v, b]; });
            wrap.appendChild(s);
            refreshers.push(() => btns.forEach(([v, b]) => b.setAttribute('aria-pressed', String(st[c.key] === v))));
          }
        }
        if (c.hint) wrap.appendChild(mk('div', 'hint', c.hint));
        sec.appendChild(wrap);
      });
      rail.appendChild(sec);
    });
    const sec = mk('section', 'group'), b = mk('button', 'btn', 'Reset to the measured figures'); b.type = 'button';
    b.addEventListener('click', () => { st = JSON.parse(JSON.stringify(DEFAULTS)); changed(); }); sec.appendChild(b); rail.appendChild(sec);
  }
  let raf = 0;
  function changed() { derive(); refreshers.forEach((f) => f()); if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  /* ====================================================================== the plan */
  const nPass = () => Math.min(st.passes, st.window);   // a pass a day at most
  const opts = (over) => Object.assign({ full: st.full, rq: st.rq, census: st.census, passes: nPass(), rt: st.rt, qt: st.qt, rtMode: st.rtMode, rtN: st.rtN, rtRate: st.rtRate, stream: st.stream }, over || {});
  const budget = () => Math.max(0, st.cap - st.reserve);
  const roundUp = (v) => { const p = v < 1000 ? 10 : v < 10000 ? 50 : v < 100000 ? 500 : 5000; return Math.ceil(v / p - 1e-9) * p; };
  const top2 = () => (st.full === Infinity ? 1e6 : st.full);
  function derive() {
    pop = CASCADE.population({ scale: D.months[st.month] * (1 + st.change), window: st.window, quoteRooted: st.quoteRooted });
    if (st.rqAuto) { const e = CASCADE.lowest(pop, opts(), 'rq', budget(), st.census, top2()); st.rq = e == null ? top2() : Math.min(top2(), roundUp(e)); }
    else st.rq = Math.max(st.rq, st.census);   // a cascade in the second tier has to be found
  }
  const passAges = () => { const end = 24 * st.window, n = nPass(); return n === 1 ? [end] : n === 2 ? [24, end] : [24, 48, end]; };
  const ageTxt = (h) => (h % 24 === 0 && h > 72 ? h / 24 + ' days' : h + ' hours');
  const agesTxt = () => { const a = passAges(); return a.every((h) => h <= 72) ? list(a.map(String)) + ' hours' : list(a.map(ageTxt)); };
  const list = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
  const bought = () => (st.rtMode === 'first' ? 'the first ' + int(st.rtN) + ' retweets of each' : st.rtMode === 'sample' ? 'a random ' + Math.round(100 * st.rtRate) + '% of their retweets' : '');
  function recipe(r, hasT1, hasT2) {
    const parts = ['Each day, search for roots posted ' + agesTxt() + ' earlier whose retweet or reply count is high enough for a cascade of ' + int(r.census) + '+ posts.',
      'Start collecting a cascade the first time its counts pass its size. Fetch its replies first: each carries its own counts, which gives a closer size.'];
    if (hasT1) parts.push('For cascades of ' + int(st.full) + '+ posts, fetch every quote and retweet.');
    if (hasT2) parts.push('For cascades of ' + int(r.rq) + '+ posts, fetch the quotes' + (st.rtMode === 'none' ? '; their retweets come from the 1% stream only.' : ' and ' + bought() + '.'));
    parts.push('Check what search found against the 1% stream: search by counts can miss a cascade whose size is spread over many replies.');
    return parts.join(' ');
  }

  /* ====================================================================== figures */
  function drawFlow(r, hasT1, hasT2, fits) {
    const host = document.getElementById('c-flow'), wide = host.clientWidth >= 820, BH = 90, uid = 'cf' + (drawFlow.n = (drawFlow.n || 0) + 1);
    const col = fits ? 'var(--ok)' : 'var(--over)', got = r.posts ? r.downloaded / r.posts : 0;
    const boxes = [
      { title: 'Search by counts', color: TIER.census, lines: [nPass() === 1 ? 'one pass, at ' + ageTxt(passAges()[0]) : 'at ' + (st.window <= 3 ? agesTxt() : passAges().map((h) => (h > 72 ? h / 24 + ' d' : h + ' h')).join(', ')), big(r.roots) + ' roots of ' + int(r.census) + '+', 'costs ' + big(r.finding) + ' units'] },
      { title: 'Replies first', lines: ['each reply carries its counts', big(r.replies) + ' replies', 'costs ' + big(r.replies) + ' units'] },
      hasT1 ? { title: 'In full, ' + int(st.full) + '+', color: TIER.full, lines: ['every quote and retweet', big(r.n1) + ' cascades', 'costs ' + big(r.t1.quotes + r.t1.retweets) + ' units'] }
            : { title: 'No cascade in full', dashed: true, lines: ['no size chosen', 'for every post', 'costs nothing'] },
      hasT2 ? { title: 'Quotes, ' + int(r.rq) + '+', color: TIER.rq, lines: [st.rtMode === 'none' ? 'retweets: 1% stream only' : st.rtMode === 'first' ? 'and first ' + int(st.rtN) + ' retweets' : 'and ' + Math.round(100 * st.rtRate) + '% of retweets', big(r.n2) + ' cascades', 'costs ' + big(r.t2.quotes + r.bought) + ' units'] }
            : { title: 'No second tier', dashed: true, lines: hasT1 ? ['replies and quotes only', 'for the cascades in full', 'costs nothing'] : ['nothing fits', 'under this cap', 'costs nothing'] },
      { title: 'Collected', color: col, fill: true, lines: [big(r.n1 + r.n2) + ' cascades a month', pct(got) + ' of their posts', big(r.total) + ' units, ' + pct(r.total / st.cap) + ' of cap'] },
    ];
    const f = frame('c-flow', wide ? BH + 34 : boxes.length * BH + (boxes.length - 1) * 24 + 10, 'The plan as a flow: search by counts, replies first, leaves for each tier, result');
    const defs = el('defs', {}, f.svg), mk = el('marker', { id: uid, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M0 0L10 5L0 10z', fill: 'var(--ink-3)' }, mk);
    const box = (b, x, y, w) => {
      el('rect', { x, y, width: w, height: BH, rx: 9, fill: b.fill ? b.color : 'var(--surface)', 'fill-opacity': b.fill ? 0.12 : 1, stroke: b.color || 'var(--line-2)', 'stroke-width': b.color ? 1.75 : 1.25, 'stroke-dasharray': b.dashed ? '4 4' : null }, f.svg);
      el('text', { x: x + 12, y: y + 24, class: 'strong', style: 'font-size:12.5px' }, f.svg, b.title);
      b.lines.forEach((t, i) => el('text', { x: x + 12, y: y + 42 + 16 * i, style: i === 2 ? 'fill:var(--ink)' : '' }, f.svg, t));
    };
    const arrow = (d) => el('path', { d, fill: 'none', stroke: 'var(--ink-3)', 'stroke-width': 1.25, 'marker-end': 'url(#' + uid + ')' }, f.svg);
    if (wide) {
      const gap = 24, w = (f.w - 4 - gap * (boxes.length - 1)) / boxes.length, labels = ['FIND', 'SIZE', 'TIER 1', 'TIER 2', 'RESULT'];
      boxes.forEach((b, i) => { const x = 2 + i * (w + gap); box(b, x, 6, w); if (i) arrow('M' + (x - gap + 2) + ' ' + (6 + BH / 2) + 'H' + x); el('text', { x: x + 2, y: 6 + BH + 16, class: 'tick' }, f.svg, labels[i]); });
    } else boxes.forEach((b, i) => { const y = 4 + i * (BH + 24); box(b, 2, y, f.w - 4); if (i) arrow('M' + f.w / 2 + ' ' + (y - 21) + 'V' + (y - 1)); });
  }

  function drawCap(r, fits) {
    const segs = [['Cascades in full', r.cost1, TIER.full], ['Replies and quotes', r.cost2, TIER.rq], ['Retweets bought', r.bought, TIER.bought], ['Search by counts', r.finding, TIER.census], ['Reserve', st.reserve, TIER.reserve]].filter((x) => x[1] > 0);
    const f = frame('c-cap', 86, 'Units a month by use, against the cap'), x0 = 2, x1 = f.w - 2, used = r.total + st.reserve, max = Math.max(st.cap, used) * 1.02, X = lin(0, max, x0, x1), y = 30, h = 26;
    el('rect', { x: x0, y, width: X(st.cap) - x0, height: h, rx: 4, fill: 'var(--sunken)' }, f.svg);
    let at = 0;
    segs.forEach(([name, v, col]) => {
      const a = X(at), b = X(at + v), w = Math.max(1.5, b - a - 2);
      const bar = el('rect', { x: a, y, width: w, height: h, rx: 3, fill: col, 'fill-opacity': name === 'Reserve' ? 0.45 : 1 }, f.svg);
      if (w > 86) el('text', { x: a + 2, y: y - 7, class: 'strong' }, f.svg, big(v));
      bar.addEventListener('pointermove', (ev) => { const bb = f.svg.getBoundingClientRect(); f.showTip(ev.clientX - bb.left, ev.clientY - bb.top, '<b>' + name + '</b>' + row(col, 'Units a month', big(v)) + row('', 'Share of the cap', pct(v / st.cap))); });
      bar.addEventListener('pointerleave', f.hideTip);
      at += v;
    });
    el('line', { x1: X(st.cap), x2: X(st.cap), y1: y - 22, y2: y + h + 6, stroke: 'var(--ink)', 'stroke-width': 1.5 }, f.svg);
    el('text', { x: X(st.cap) - 6, y: y - 12, 'text-anchor': 'end', class: 'strong' }, f.svg, 'Cap ' + big(st.cap));
    el('text', { x: x0, y: y + h + 20 }, f.svg, fits ? big(st.cap - used) + ' units to spare after the reserve' : big(used - st.cap) + ' units over the cap with the reserve');
    legend('c-leg-cap', segs.map(([name, v, col]) => ['box', col, name, name === 'Reserve' ? 'opacity:.45' : '']));
  }

  function drawTiers(r, hasT1, hasT2) {
    const rows = [];
    if (hasT1) rows.push(['In full', int(st.full) + '+ posts', r.A, r.cost1, TIER.full, r.n1, 'every post']);
    if (hasT2) rows.push(['Replies and quotes', int(r.rq) + ' to ' + (st.full === Infinity ? 'the largest' : int(st.full - 1)), r.B, r.cost2 + r.bought, TIER.rq, r.n2, st.rtMode === 'none' ? 'no retweets bought' : 'with ' + big(r.bought) + ' retweets']);
    if (r.n3 > 0) rows.push(['Root and counts', int(r.census) + ' to ' + int(r.rq - 1), r.censusPosts, r.n3 + r.q3, TIER.census, r.n3, 'the root only, charged on each pass']);
    const rowH = 50, f = frame('c-mix', rows.length * rowH + 34, 'Posts in each tier and how many of them are downloaded');
    const wide = f.w >= 620, m = { l: wide ? 150 : 4, r: wide ? 232 : 64, t: 4 }, x0 = m.l, x1 = f.w - m.r, max = Math.max.apply(null, rows.map((x) => x[2])), X = lin(0, max, x0, x1), yb = m.t + rows.length * rowH;
    rows.forEach(([name, range, all, got, col, n, note], i) => {
      const y = m.t + i * rowH, top = y + (wide ? 12 : 20);
      el('text', { x: wide ? x0 - 12 : x0, y: wide ? top + 9 : y + 12, 'text-anchor': wide ? 'end' : 'start', class: 'strong' }, f.svg, name);
      if (wide) el('text', { x: x0 - 12, y: top + 24, 'text-anchor': 'end' }, f.svg, range);
      el('rect', { x: x0, y: top, width: Math.max(1, X(all) - x0), height: 22, rx: 3, fill: col, 'fill-opacity': 0.16 }, f.svg);
      el('rect', { x: x0, y: top, width: Math.max(1.5, X(got) - x0), height: 22, rx: 3, fill: col }, f.svg);
      const t = el('text', { x: X(all) + 8, y: top + 15 }, f.svg); el('tspan', { class: 'strong', style: 'fill:var(--ink)' }, t, big(all)); if (wide) el('tspan', {}, t, '  ' + big(n) + ' cascades, ' + note);
      const hit = el('rect', { x: 0, y, width: f.w, height: rowH, fill: 'transparent' }, f.svg);
      hit.addEventListener('pointermove', (ev) => { const b = f.svg.getBoundingClientRect(); f.showTip(ev.clientX - b.left, ev.clientY - b.top, '<b>' + name + ' · ' + range + '</b>' + row('', 'Cascades a month', big(n)) + row('', 'Posts in them', big(all)) + row(col, 'Downloaded', big(got) + ' · ' + pct(all ? got / all : 0))); });
      hit.addEventListener('pointerleave', f.hideTip);
    });
    el('line', { x1: x0, x2: x1, y1: yb, y2: yb, stroke: 'var(--line-2)' }, f.svg);
    const step = U.niceStep(max / 4);
    for (let v = 0; v <= max * 1.001; v += step) { el('line', { x1: X(v), x2: X(v), y1: yb, y2: yb + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: yb + 18, 'text-anchor': v === 0 ? 'start' : 'middle', class: 'tick' }, f.svg, v === 0 ? '0' : big(v)); }
    el('text', { x: x1, y: f.h - 2, 'text-anchor': 'end' }, f.svg, 'posts a month');
    legend('c-leg-mix', [['box', 'var(--ink-2)', 'Downloaded'], ['box', 'var(--ink-2)', 'In the tier, not downloaded', 'opacity:.2']]);
  }

  function drawFit(r, hasT2) {
    const f = frame('c-fit', 330, 'Units a month against the smallest cascade collected, with the measured sizes');
    const m = { l: 46, r: 16, t: 20, b: 42 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t, lo = 100, hi = 100000;
    const every = (s) => pop.P(s), rq = (s) => (1 - st.rt) * pop.P(s), mine = (s) => CASCADE.plan(pop, opts({ rq: s })).total;
    const xs = []; for (let i = 0; i <= 120; i++) xs.push(lo * Math.pow(hi / lo, i / 120));
    const mineXs = xs.filter((x) => x >= st.census && x <= top2());
    const all = xs.map(every).concat(xs.map(rq), [st.cap]), X = logS(lo, hi, x0, x1), Y = logS(Math.min.apply(null, all) / 1.4, Math.max.apply(null, all) * 1.4, y0, y1);
    el('rect', { x: x0, y: y1, width: x1 - x0, height: Math.max(0, Y(st.cap) - y1), fill: 'var(--over)', 'fill-opacity': 0.05 }, f.svg);
    el('rect', { x: x0, y: y1, width: X(1000) - x0, height: y0 - y1, fill: 'var(--sunken)', 'fill-opacity': 0.7 }, f.svg);
    el('text', { x: x0 + 8, y: y0 - 10 }, f.svg, 'below 1,000: rough');
    for (const v of logTicks(Y.inv(y0), Y.inv(y1))) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, big(v)); }
    for (const v of [100, 1000, 10000, 100000]) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': v === hi ? 'end' : 'middle', class: 'tick' }, f.svg, int(v)); }
    el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
    el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Smallest cascade collected, in posts (log scale)');
    el('line', { x1: x0, x2: x1, y1: Y(st.cap), y2: Y(st.cap), stroke: 'var(--ink)', 'stroke-width': 1.25 }, f.svg);
    el('text', { x: x1 - 4, y: Y(st.cap) - 6, 'text-anchor': 'end', class: 'strong' }, f.svg, 'Cap ' + big(st.cap));
    if (st.reserve > 0 && budget() > 0) el('line', { x1: x0, x2: x1, y1: Y(budget()), y2: Y(budget()), stroke: 'var(--ink-3)', 'stroke-dasharray': '4 4' }, f.svg);
    const line = (pts, col, w) => el('path', { d: path(pts), fill: 'none', stroke: col, 'stroke-width': w, 'stroke-linejoin': 'round' }, f.svg);
    line(xs.map((x) => [X(x), Y(every(x))]), TIER.full, 2); line(xs.map((x) => [X(x), Y(rq(x))]), TIER.rq, 2);
    if (mineXs.length > 1) line(mineXs.map((x) => [X(x), Y(mine(x))]), 'var(--ink)', 2.75);
    D.S.forEach((s) => [[every, TIER.full], [rq, TIER.rq]].forEach(([fn, col]) => el('circle', { cx: X(s), cy: Y(fn(s)), r: 4.5, fill: col, stroke: 'var(--surface)', 'stroke-width': 2 }, f.svg)));
    if (st.full !== Infinity) { el('line', { x1: X(st.full), x2: X(st.full), y1: y1, y2: y0, stroke: TIER.full, 'stroke-dasharray': '2 4' }, f.svg); el('text', { x: X(st.full) + 6, y: y1 + 8, style: 'fill:var(--ink)' }, f.svg, 'in full from ' + int(st.full)); }
    if (hasT2) el('circle', { cx: X(r.rq), cy: Y(r.total), r: 5.5, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 2.5 }, f.svg);
    const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', visibility: 'hidden' }, f.svg), ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
    ov.addEventListener('pointermove', (ev) => {
      const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width, s = +X.inv(px).toPrecision(2);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      f.showTip(px * b.width / f.w, ev.clientY - b.top, '<b>Cascades of ' + int(s) + '+ posts' + (s < 1000 ? ' (rough)' : '') + '</b>' + row('', 'How many a month', big(pop.N(s)))
        + row(TIER.full, 'Every post', big(every(s)) + ' units') + row(TIER.rq, 'Replies and quotes', big(rq(s)) + ' units')
        + (s >= st.census && s <= top2() ? row('var(--ink)', 'Your plan, second tier from here', big(mine(s)) + ' units') : ''));
    });
    ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    legend('c-leg-fit', [['', TIER.full, 'Every post, from this size up'], ['', TIER.rq, 'Replies and quotes, from this size up'], ['', 'var(--ink)', 'Your plan, as its second tier reaches lower'], ['dot', 'var(--ink-2)', 'At the measured sizes']]);
  }

  function drawGrow() {
    const f = frame('c-grow', 310, 'Median share of the seven-day size reached, by hours since the root, for three size classes');
    const m = { l: 44, r: 16, t: 24, b: 42 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t, X = logS(1, 168, x0, x1), Y = lin(0, 1, y0, y1), G = D.growth, names = Object.keys(G).filter((k) => k !== 'hours');
    for (const v of [0, 0.25, 0.5, 0.75, 1]) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, Math.round(100 * v) + '%'); }
    for (const v of [1, 3, 6, 12, 24, 48, 72, 168]) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': v === 168 ? 'end' : 'middle', class: 'tick' }, f.svg, String(v)); }
    el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
    el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Hours since the root was posted (log scale)');
    passAges().forEach((h, i) => { el('line', { x1: X(h), x2: X(h), y1: y1 - 6, y2: y0, stroke: 'var(--ink)', 'stroke-width': 1.25, 'stroke-dasharray': '2 4' }, f.svg); el('text', { x: X(h) - 5, y: y1 - 10, 'text-anchor': 'end', class: 'strong' }, f.svg, (i ? '' : 'pass ') + (i + 1)); });
    const hrs = G.hours.concat([168]);
    names.forEach((k, i) => { const v = G[k].concat([1]); el('path', { d: path(hrs.map((h, j) => [X(h), Y(v[j])])), fill: 'none', stroke: KIND[i], 'stroke-width': 2, 'stroke-linejoin': 'round' }, f.svg);
      G.hours.forEach((h, j) => el('circle', { cx: X(h), cy: Y(v[j]), r: 4, fill: KIND[i], stroke: 'var(--surface)', 'stroke-width': 2 }, f.svg)); });
    const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', visibility: 'hidden' }, f.svg), ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
    ov.addEventListener('pointermove', (ev) => {
      const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width; let j = 0; G.hours.forEach((h, q) => { if (Math.abs(X(h) - px) < Math.abs(X(G.hours[j]) - px)) j = q; });
      cross.setAttribute('x1', X(G.hours[j])); cross.setAttribute('x2', X(G.hours[j])); cross.setAttribute('visibility', 'visible');
      f.showTip(X(G.hours[j]) * b.width / f.w, ev.clientY - b.top, '<b>' + G.hours[j] + (G.hours[j] === 1 ? ' hour' : ' hours') + ' after the root</b>' + names.map((k, i) => row(KIND[i], k + ' posts', 'about ' + Math.round(100 * G[k][j]) + '%')).join(''));
    });
    ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    legend('c-leg-grow', names.map((k, i) => ['', KIND[i], k + ' posts']));
  }

  function drawFind() {
    const f = frame('c-find', 310, 'Chance that a cascade is found, by its size: the 1% stream, and the most that search by counts can find');
    const m = { l: 44, r: 16, t: 24, b: 42 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t, X = logS(10, 10000, x0, x1), Y = lin(0, 1, y0, y1);
    for (const v of [0, 0.25, 0.5, 0.75, 1]) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, Math.round(100 * v) + '%'); }
    for (const v of [10, 100, 1000, 10000]) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': v === 10000 ? 'end' : 'middle', class: 'tick' }, f.svg, int(v)); }
    el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
    el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Cascade size, in posts (log scale)');
    const xs = []; for (let i = 0; i <= 120; i++) xs.push(10 * Math.pow(1000, i / 120));
    const series = [[1, 'var(--ink)', 2.75, null], [3, 'var(--ref)', 1.5, '5 4']];
    series.forEach(([h, col, w, dash]) => el('path', { d: path(xs.map((x) => [X(x), Y(CASCADE.binomSf(h, Math.round(x), st.stream))])), fill: 'none', stroke: col, 'stroke-width': w, 'stroke-dasharray': dash }, f.svg));
    el('path', { d: 'M' + X(st.census) + ' ' + y0 + 'V' + Y(1) + 'H' + x1, fill: 'none', stroke: TIER.census, 'stroke-width': 2.25, 'stroke-dasharray': '6 4', 'stroke-linejoin': 'round' }, f.svg);
    el('text', { x: X(st.census) + 8, y: Y(1) - 8, class: 'strong' }, f.svg, 'search by counts, at most');
    const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', visibility: 'hidden' }, f.svg), ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
    ov.addEventListener('pointermove', (ev) => {
      const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width, s = Math.round(X.inv(px));
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      f.showTip(px * b.width / f.w, ev.clientY - b.top, '<b>A cascade of ' + int(s) + ' posts</b>' + row(TIER.census, 'Search by counts', s >= st.census ? 'if its root’s count passes' : 'below the size searched')
        + series.map(([h, col]) => row(col, 'Stream, ' + h + (h === 1 ? ' sampled post' : ' sampled posts'), pct(CASCADE.binomSf(h, s, st.stream)))).join(''));
    });
    ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    legend('c-leg-find', [['', TIER.census, 'Search by counts, at most'], ['', 'var(--ink)', '1% stream, one sampled post'], ['', 'var(--ref)', '1% stream, three sampled posts']]);
  }

  /* ====================================================================== render */
  function render() {
    if (!pop) derive();
    const hasT1 = st.full !== Infinity, hasT2 = st.rq < top2(), r = CASCADE.plan(pop, opts(hasT2 ? {} : { rq: Infinity })), fits = r.total <= budget() + 1, S = D.streamOnly;
    document.getElementById('c-facts').innerHTML = [
      ['Cascades of 1,000+ a month', big(pop.N(1000))],
      ['Posts in them', big(pop.P(1000))],
      ['Cascades of 10,000+ a month', big(pop.N(10000))],
      ['Their share of those posts', pct(pop.P(10000) / pop.P(1000))],
      ['Cascades of 100+ a month, rough', big(pop.N(100))],
    ].concat(st.quoteRooted ? [['Rooted at a quote, 1,000+, estimated', big(pop.NQ(1000))]] : []).map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
    const pill = document.getElementById('c-pill'); pill.className = 'pill ' + (fits ? 'ok' : 'short'); pill.textContent = fits ? 'Fits the cap' : 'Over the cap';
    const rqWords = st.rtMode === 'first' ? 'replies, quotes and first ' + int(st.rtN) + ' retweets' : st.rtMode === 'sample' ? 'replies, quotes and a random ' + Math.round(100 * st.rtRate) + '% of the retweets' : 'replies and quotes';
    const subject = hasT1 && hasT2 ? 'Every post of the ' + big(r.n1) + ' cascades of ' + int(st.full) + '+ posts, and the ' + rqWords + ' of ' + big(r.n2) + ' more down to ' + int(r.rq) + ' posts,'
      : hasT1 ? 'Every post of the ' + big(r.n1) + ' cascades of ' + int(st.full) + '+ posts'
      : hasT2 ? 'The ' + rqWords + ' of the ' + big(r.n2) + ' cascades of ' + int(r.rq) + '+ posts'
      : 'Search by counts alone';
    const plural = hasT2;
    document.getElementById('c-headline').textContent = subject + (fits ? (plural ? ' cost ' : ' costs ') + big(r.total) + ' units a month, ' + pct(r.total / st.cap) + ' of the cap.'
      : (plural ? ' need ' : ' needs ') + big(r.total) + ' units a month, ' + (budget() > 0 ? 'more than the ' + big(budget()) + ' available.' : 'and the reserve takes the whole cap.'));
    let fix = '';
    if (!fits) {
      const e = CASCADE.lowest(pop, opts(), 'rq', budget(), st.census, top2()), g = CASCADE.lowest(pop, opts({ rq: Infinity }), 'full', budget(), 1000, 1e6);
      fix = e != null ? ' Replies and quotes fit from about ' + int(roundUp(e)) + '+ posts.' : g != null ? ' Every post alone fits only from about ' + int(roundUp(g)) + '+ posts.' : '';
    }
    if (hasT2 && r.rq < 1000) fix += ' Sizes below 1,000 posts are rough.';
    if (pop.windowRough) fix += ' A ' + (st.window === 1 ? 'one' : 'two') + '-day window collects about ' + pct(pop.shrink) + ' of the posts these cascades have in seven days, and ' + pct(D.window[st.window].keep) + ' of the seven-day cascades of 10,000+ reach 10,000 in it. ' + (st.window === 1 ? 'The first figure is an estimate.' : 'Both figures are estimates.');
    document.getElementById('c-recipe').textContent = recipe(r, hasT1, hasT2) + fix;
    const more = (q) => (q >= 0.5 ? '; about ' + big(+q.toPrecision(2)) + ' more rooted at a quote' : '');
    const k = [
      ['Cascades collected in full', hasT1 ? big(r.n1) : 'none', hasT1 ? int(st.full) + '+ posts; ' + big(r.cost1) + ' units' + more(r.q1) : 'no size chosen'],
      [st.rtMode === 'none' ? 'With replies and quotes only' : 'With replies, quotes and some retweets', hasT2 ? big(r.n2) : 'none', hasT2 ? 'down to ' + int(r.rq) + ' posts; ' + big(r.cost2 + r.bought) + ' units' + more(r.q2) : 'no second tier'],
      ['Units spent a month', big(r.total), pct(r.total / st.cap) + ' of the cap' + (st.reserve ? '; ' + big(st.reserve) + ' in reserve' : '')],
      ['Cascades with their reply trees', big(r.n1 + r.n2), 'if search finds them all; the stream-only design aims at the ' + int(S.cascades) + ' of 10,000+'],
    ];
    document.getElementById('c-kpis').innerHTML = k.map(([a, b, s]) => '<div class="kpi"><div class="k">' + a + '</div><div class="v">' + b + '</div><div class="s">' + s + '</div></div>').join('');
    document.getElementById('c-sub-flow').textContent = 'The plan in the headline, step by step, in numbers a month. One unit is the charge for one post returned.';
    document.getElementById('c-sub-mix').textContent = 'The bar shows where the cap goes. Below it, each tier’s posts, with the downloaded part solid. Retweets are ' + Math.round(100 * st.rt) + '% of posts, so collecting them for every cascade is what does not fit.';
    const fitAll = CASCADE.lowest(pop, opts({ rq: Infinity, passes: 0 }), 'full', st.cap, 1000, 1e6), fitRQ = CASCADE.lowest(pop, opts({ full: Infinity, passes: 0 }), 'rq', st.cap, 100, 1e6);
    document.getElementById('c-sub-fit').textContent = 'Units a month against the smallest cascade collected. Dots are at the measured sizes. With no search passes counted, every post fits the cap from about ' + (fitAll ? int(roundUp(fitAll)) : '?') + '+ posts, and replies and quotes from about ' + (fitRQ ? int(roundUp(fitRQ)) + '+' + (fitRQ < 1000 ? ' (rough)' : '') : '?') + '. The black line is your plan as its second tier reaches lower.';
    document.getElementById('c-sub-grow').textContent = 'Median share of a cascade’s seven-day size reached by each hour. The median cascade has about 99% of it at 48 hours. Of the cascades that end at 10,000+ posts, ' + pct(D.passed10k[24]) + ' have passed 10,000 in total size by 24 hours and ' + pct(D.passed10k[72]) + ' by 72. A root’s own counts pass later than the total; how much later has not been measured.';
    document.getElementById('c-sub-find').textContent = 'The 1% stream notices a cascade only if one of its posts is sampled: ' + pct(CASCADE.binomSf(1, 100, st.stream)) + ' of the time at 100 posts. Search filters on one post’s own retweet or reply count, so the dashed line is the most it can find: a cascade whose size is spread over many replies, or sits on quotes, can be missed. The share missed has not been measured.';
    document.getElementById('c-foot-build').textContent = 'Cascade view, fourth version · 20 November 2026. Sizes were counted by Prof. Toyoda’s group on the full Japanese stream for September 2026: ' + int(D.N[0]) + ' cascades of 1,000+ posts holding ' + big(D.P[0]) + ' posts, ' + int(D.N[2]) + ' of 10,000+ holding ' + big(D.P[2]) + '.';
    drawFlow(r, hasT1, hasT2, fits); drawCap(r, fits); drawTiers(r, hasT1, hasT2); drawFit(r, hasT2); drawGrow(); drawFind();
  }

  /* ====================================================================== view switch */
  const views = { cascades: document.getElementById('view-cascades'), trees: document.getElementById('view-trees') };
  const tabs = { cascades: document.getElementById('tab-cascades'), trees: document.getElementById('tab-trees') };
  const INTRO = { cascades: 'Cascade sizes are measured counts for September 2026. Set the cap, the mix of posts and three sizes; the results update as you move a control: what fits under the cap, what it costs, and what is left out.',
                  trees: 'The reply part of a cascade, modelled in detail. Set your assumptions about replies on Japanese-language X, the quota and what you want to collect; the results update as you move a control.' };
  function show(v) {
    for (const k in views) { views[k].hidden = k !== v; tabs[k].setAttribute('aria-pressed', String(k === v)); }
    ['status', 'btn-copy', 'btn-reset'].forEach((id) => { document.getElementById(id).hidden = v !== 'trees'; });
    document.getElementById('intro').textContent = INTRO[v];
    if (v === 'trees') { PLANNER.rerender(); window.dispatchEvent(new Event('resize')); } else changed();
    try { history.replaceState(null, '', v === 'trees' ? '#reply-trees' : '#cascades'); } catch (e) { /* not available in every viewer */ }
  }
  tabs.cascades.addEventListener('click', () => show('cascades')); tabs.trees.addEventListener('click', () => show('trees'));
  let rz = 0; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (!views.cascades.hidden) render(); }, 130); });
  build(); show(location.hash === '#reply-trees' ? 'trees' : 'cascades');
  window.CASCADE_VIEW = { get state() { return st; }, DEFAULTS };
})();
