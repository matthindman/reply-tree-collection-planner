/* cascades.js — the cascade view: controls, verdict and figures. Arithmetic is in cascade_model.js.
   To change a default or a label, edit DEFAULTS and GROUPS below, then run build.py. */
(function () {
  'use strict';
  const U = PLANNER.ui, el = U.el, frame = U.frame, lin = U.lin, logS = U.logS, logTicks = U.logTicks, path = U.path, legend = U.legend, row = U.row, big = U.big, pct = U.pct, int = U.int;

  /* ====================================================================== defaults */
  // Figures given by the collaborators on 19 November 2026 for a three-day window. Inputs, not measurements made here.
  const DEFAULTS = {
    cap: 1e8,            // units a month
    stream: 0.01,        // share of all posts in the stream; the stream is outside the cap
    days: 3,             // observation window
    n1000: 122000,       // cascades of 1,000+ posts a month
    p1000: 3.4e8,        // posts in them, quotes aside
    q1000: 4.5e7,        // quotes of them
    rt: 0.87,            // retweets as a share of those posts (given as 85 to 89%)
    nAll: 1.57e6,        // cascades counted a month; its size floor is not known, so it is only reported
    cut: 1000, quotes: true, under: 0, rtMode: 'none', rtN: 1000, rtShare: 1, hits: 1,
  };
  const CUTS = [200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 50000, 100000];
  const TYPE = { replies: 'var(--root)', quotes: 'var(--both)', retweets: 'var(--sample)' };
  let st = JSON.parse(JSON.stringify(DEFAULTS));

  const GROUPS = [
    { title: 'The contract', controls: [
      { key: 'cap', kind: 'log', label: 'Monthly cap, in units', min: 1e7, max: 1e9, fmt: big, hint: 'One unit is the charge for one post returned.' },
      { key: 'stream', kind: 'seg', label: 'Sample stream, outside the cap', options: [[0, 'None'], [0.01, '1%'], [0.1, '10%']],
        hint: 'A random share of all posts, retweets included. It does not count against the cap.' },
      { key: 'days', kind: 'range', label: 'Window after the root is posted', min: 1, max: 7, step: 1, fmt: (v) => v + (v === 1 ? ' day' : ' days') },
    ] },
    { title: 'Cascades of 1,000+ posts, a month', controls: [
      { key: 'n1000', kind: 'log', label: 'How many there are', min: 1e4, max: 1e6, fmt: big },
      { key: 'p1000', kind: 'log', label: 'Posts in them, quotes aside', min: 3e7, max: 3e9, fmt: big, hint: 'Roots, replies and retweets.' },
      { key: 'q1000', kind: 'log', label: 'Quotes of them', min: 1e6, max: 5e8, fmt: big },
      { key: 'rt', kind: 'range', label: 'Retweets, as a share of those posts', min: 0.7, max: 0.97, step: 0.01, fmt: (v) => Math.round(100 * v) + '%', hint: 'Given as 85 to 89%.' },
      { key: 'nAll', kind: 'log', label: 'All cascades counted a month', min: 2e5, max: 2e7, fmt: big, hint: 'Used only to report the smallest size this count corresponds to.' },
      { kind: 'facts', id: 'c-facts' },
    ] },
    { title: 'What to collect', controls: [
      { key: 'cut', kind: 'pick', label: 'Cascades of at least', choices: CUTS, fmt: (v) => int(v) + ' posts' },
      { key: 'quotes', kind: 'check', label: 'Download quotes' },
      { key: 'under', kind: 'range', label: 'Posts under each quote', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2), disabled: () => !st.quotes,
        hint: 'Replies to a quote, and quotes of it, per quote. Unknown; 0 leaves them out.' },
      { key: 'rtMode', kind: 'seg', label: 'Download retweets', options: [['none', 'None'], ['first', 'First N'], ['all', 'All']],
        hint: 'None keeps the stream sample and the daily counts only.' },
      { key: 'rtN', kind: 'pick', label: 'Retweets read from each cascade', choices: [100, 500, 1000, 5000, 10000], fmt: (v) => 'first ' + int(v), disabled: () => st.rtMode !== 'first' },
      { key: 'rtShare', kind: 'range', label: 'For this share of cascades', min: 0.05, max: 1, step: 0.05, fmt: (v) => Math.round(100 * v) + '%', disabled: () => st.rtMode === 'none',
        hint: 'A random share of cascades gets its retweets downloaded.' },
      { key: 'hits', kind: 'range', label: 'Sampled posts needed to flag a cascade', min: 1, max: 5, step: 1, fmt: (v) => String(v), disabled: () => !(st.stream > 0) },
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
    const sec = mk('section', 'group'), b = mk('button', 'btn', 'Reset to the figures given'); b.type = 'button';
    b.addEventListener('click', () => { st = JSON.parse(JSON.stringify(DEFAULTS)); changed(); }); sec.appendChild(b); rail.appendChild(sec);
  }
  let raf = 0;
  function changed() { refreshers.forEach((f) => f()); if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  /* ====================================================================== words */
  const opts = (over) => Object.assign({ cut: st.cut, quotes: st.quotes, under: st.under, rtMode: st.rtMode, rtN: st.rtN, rtShare: st.rtShare, days: st.days, stream: st.stream, hits: st.hits }, over || {});
  const streamName = () => (100 * st.stream) + '% stream';
  function what() {
    const base = st.quotes ? 'Replies and quotes' : 'Replies';
    if (st.rtMode === 'none') return base;
    const share = st.rtShare < 0.995 ? ' for ' + Math.round(100 * st.rtShare) + '% of cascades' : '';
    if (st.rtMode === 'all') return st.quotes && !share ? 'Every post' : base + ', and every retweet' + share;
    return base + ', and the first ' + int(st.rtN) + ' retweets' + share;
  }
  function recipe(r) {
    const parts = [];
    parts.push(st.stream > 0 ? 'Flag a cascade when ' + (st.hits === 1 ? 'one of its posts appears' : st.hits + ' of its posts appear') + ' in the ' + streamName() + '.'
      : 'Search each day for roots whose repost count shows a cascade of at least ' + int(st.cut / 2) + ' posts.');
    parts.push('Look up each flagged root’s counts once a day until day ' + st.days + ', and keep those that reach ' + int(st.cut) + ' posts.');
    parts.push('Download their replies' + (st.quotes ? ' and quotes' : '') + '.');
    parts.push(st.rtMode === 'none' ? (st.stream > 0 ? 'Take retweets from the stream sample and the daily counts.' : 'Take retweet totals from the daily counts.')
      : 'Download ' + (st.rtMode === 'all' ? 'every retweet' : 'the first ' + int(st.rtN) + ' retweets of each') + (st.rtShare < 0.995 ? ', for a random ' + Math.round(100 * st.rtShare) + '% of cascades.' : '.'));
    return parts.join(' ');
  }

  /* ====================================================================== figures */
  function drawFlow(pop, r) {
    const host = document.getElementById('c-flow'), wide = host.clientWidth >= 820, BH = 90, uid = 'cf' + (drawFlow.n = (drawFlow.n || 0) + 1);
    const col = r.total <= st.cap ? 'var(--ok)' : 'var(--over)';
    const boxes = [
      st.stream > 0 ? { title: streamName().replace(/^./, (c) => c.toUpperCase()), color: 'var(--ink-2)', lines: ['flags at the ' + (st.hits === 1 ? 'first' : st.hits + ordSuffix(st.hits)) + ' sampled post', pct(r.found) + ' of ' + int(st.cut) + '+ cascades', 'outside the cap'] }
                    : { title: 'Search by repost count', color: 'var(--ink-2)', lines: ['roots near ' + int(st.cut / 2) + '+ posts', big(r.watched) + ' roots a month', 'costs ' + big(r.finding) + ' units'] },
      { title: 'Check the root’s counts', lines: ['once a day to day ' + st.days, big(r.watched) + ' cascades watched', 'costs ' + big(r.checks) + ' units'] },
      { title: st.quotes ? 'Download replies, quotes' : 'Download replies', lines: [big(r.replies) + ' replies and roots', st.quotes ? big(r.quotes + r.under) + ' quotes' + (r.under > 0 ? ' and posts under' : '') : 'quotes left out', 'costs ' + big(r.replies + r.quotes + r.under) + ' units'] },
      st.rtMode === 'none' ? { title: 'Retweets, not downloaded', dashed: true, lines: [st.stream > 0 ? big(r.sampledRt) + ' in the stream sample' : 'no sample without a stream', 'totals from daily counts', 'costs nothing'] }
                           : { title: 'Download retweets', color: TYPE.retweets, lines: [st.rtMode === 'all' ? 'every retweet' : 'first ' + int(st.rtN) + ' of each', st.rtShare < 0.995 ? 'for ' + Math.round(100 * st.rtShare) + '% of cascades' : 'for every cascade', 'costs ' + big(r.retweets) + ' units'] },
      { title: 'Collected', color: col, fill: true, lines: [big(r.cascades) + ' cascades a month', pct(r.downloaded / r.allPosts) + ' of posts downloaded', big(r.total) + ' units, ' + pct(r.total / st.cap) + ' of cap'] },
    ];
    const f = frame('c-flow', wide ? BH + 34 : boxes.length * BH + (boxes.length - 1) * 24 + 10, 'The cascade plan as a flow: find, check size, download replies and quotes, retweets, result');
    const defs = el('defs', {}, f.svg), mk = el('marker', { id: uid, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M0 0L10 5L0 10z', fill: 'var(--ink-3)' }, mk);
    const box = (b, x, y, w) => {
      el('rect', { x, y, width: w, height: BH, rx: 9, fill: b.fill ? b.color : 'var(--surface)', 'fill-opacity': b.fill ? 0.12 : 1, stroke: b.color || 'var(--line-2)', 'stroke-width': b.color ? 1.75 : 1.25, 'stroke-dasharray': b.dashed ? '4 4' : null }, f.svg);
      el('text', { x: x + 12, y: y + 24, class: 'strong', style: 'font-size:12.5px' }, f.svg, b.title);
      b.lines.forEach((t, i) => el('text', { x: x + 12, y: y + 42 + 16 * i, style: i === 2 ? 'fill:var(--ink)' : '' }, f.svg, t));
    };
    const arrow = (d) => el('path', { d, fill: 'none', stroke: 'var(--ink-3)', 'stroke-width': 1.25, 'marker-end': 'url(#' + uid + ')' }, f.svg);
    if (wide) {
      const gap = 24, w = (f.w - 4 - gap * (boxes.length - 1)) / boxes.length, labels = ['FIND', 'CHECK SIZE', 'DOWNLOAD', 'RETWEETS', 'RESULT'];
      boxes.forEach((b, i) => { const x = 2 + i * (w + gap); box(b, x, 6, w); if (i) arrow('M' + (x - gap + 2) + ' ' + (6 + BH / 2) + 'H' + x); el('text', { x: x + 2, y: 6 + BH + 16, class: 'tick' }, f.svg, labels[i]); });
    } else boxes.forEach((b, i) => { const y = 4 + i * (BH + 24); box(b, 2, y, f.w - 4); if (i) arrow('M' + f.w / 2 + ' ' + (y - 21) + 'V' + (y - 1)); });
  }
  const low = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  const ordSuffix = (h) => (h === 2 ? 'nd' : h === 3 ? 'rd' : 'th');

  function drawMix(pop, r) {
    const rows = [
      ['Retweets', r.allRt, r.retweets, TYPE.retweets, st.rtMode === 'none' ? (st.stream > 0 ? 'stream sample and daily counts only' : 'daily counts only') : pct(r.retweets / r.allRt) + ' downloaded'],
      ['Replies and roots', r.replies, r.replies, TYPE.replies, 'downloaded in full'],
      ['Quotes', (pop.Q(st.cut)) * r.found, r.quotes, TYPE.quotes, st.quotes ? 'downloaded in full' : 'left out'],
    ];
    const rowH = 46, f = frame('c-mix', rows.length * rowH + 34, 'Posts in the cascades collected, by kind, and how many of each are downloaded');
    const wide = f.w >= 620, m = { l: wide ? 140 : 4, r: wide ? 250 : 70, t: 4 }, x0 = m.l, x1 = f.w - m.r, max = Math.max.apply(null, rows.map((x) => x[1])), X = lin(0, max, x0, x1), yb = m.t + rows.length * rowH;
    rows.forEach(([name, all, got, col, note], i) => {
      const y = m.t + i * rowH, top = y + (wide ? 10 : 18);
      el('text', { x: wide ? x0 - 12 : x0, y: wide ? top + 15 : y + 12, 'text-anchor': wide ? 'end' : 'start', class: 'strong' }, f.svg, name);
      el('rect', { x: x0, y: top, width: Math.max(1, X(all) - x0), height: 22, rx: 3, fill: col, 'fill-opacity': 0.16 }, f.svg);
      if (got > 0) el('rect', { x: x0, y: top, width: Math.max(1.5, X(got) - x0), height: 22, rx: 3, fill: col }, f.svg);
      const t = el('text', { x: X(all) + 8, y: top + 15 }, f.svg); el('tspan', { class: 'strong', style: 'fill:var(--ink)' }, t, big(all)); if (wide) el('tspan', {}, t, '  ' + note);
      const hit = el('rect', { x: 0, y, width: f.w, height: rowH, fill: 'transparent' }, f.svg);
      hit.addEventListener('pointermove', (ev) => { const b = f.svg.getBoundingClientRect(); f.showTip(ev.clientX - b.left, ev.clientY - b.top, '<b>' + name + '</b>' + row('', 'In the cascades collected', big(all)) + row('', 'Downloaded', big(got) + ' · ' + pct(all ? got / all : 0)) + (name === 'Retweets' && st.stream > 0 ? row('', 'Seen in the stream sample', big(r.sampledRt)) : '')); });
      hit.addEventListener('pointerleave', f.hideTip);
    });
    el('line', { x1: x0, x2: x1, y1: yb, y2: yb, stroke: 'var(--line-2)' }, f.svg);
    const step = U.niceStep(max / 4);
    for (let v = 0; v <= max * 1.001; v += step) { el('line', { x1: X(v), x2: X(v), y1: yb, y2: yb + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: yb + 18, 'text-anchor': v === 0 ? 'start' : 'middle', class: 'tick' }, f.svg, v === 0 ? '0' : big(v)); }
    el('text', { x: x1, y: f.h - 2, 'text-anchor': 'end' }, f.svg, 'posts a month');
    legend('c-leg-mix', [['box', 'var(--ink-2)', 'Downloaded'], ['box', 'var(--ink-2)', 'Not downloaded', 'opacity:.2']]);
  }

  function drawFit(pop, r) {
    const f = frame('c-fit', 310, 'Units a month needed against the smallest cascade collected, for four plans');
    const m = { l: 46, r: 16, t: 20, b: 42 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t, lo = 200, hi = 200000;
    const series = [
      ['Replies only', TYPE.replies, 1.75, { quotes: false, rtMode: 'none' }],
      ['Replies and quotes', TYPE.quotes, 1.75, { quotes: true, rtMode: 'none' }],
      ['Every post', TYPE.retweets, 1.75, { quotes: true, rtMode: 'all', rtShare: 1 }],
      ['Your plan', 'var(--ink)', 2.75, {}],
    ];
    const xs = []; for (let i = 0; i <= 90; i++) xs.push(lo * Math.pow(hi / lo, i / 90));
    const vals = series.map((s) => xs.map((x) => CASCADE.plan(pop, opts(Object.assign({ cut: x }, s[3]))).total));
    let vmin = Infinity, vmax = 0; vals.forEach((v) => v.forEach((y) => { if (y < vmin) vmin = y; if (y > vmax) vmax = y; }));
    const X = logS(lo, hi, x0, x1), Y = logS(Math.min(vmin, st.cap) / 1.5, Math.max(vmax, st.cap) * 1.5, y0, y1);
    el('rect', { x: x0, y: y1, width: x1 - x0, height: Math.max(0, Y(st.cap) - y1), fill: 'var(--over)', 'fill-opacity': 0.05 }, f.svg);
    for (const v of logTicks(Y.inv(y0), Y.inv(y1))) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, big(v)); }
    for (const v of [200, 1000, 10000, 100000]) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': 'middle', class: 'tick' }, f.svg, int(v)); }
    el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
    el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Smallest cascade collected, in posts (log scale)');
    el('line', { x1: x0, x2: x1, y1: Y(st.cap), y2: Y(st.cap), stroke: 'var(--ink)', 'stroke-width': 1.25 }, f.svg);
    el('text', { x: x1 - 4, y: Y(st.cap) - 6, 'text-anchor': 'end', class: 'strong' }, f.svg, 'Cap ' + big(st.cap));
    series.forEach((s, i) => el('path', { d: path(xs.map((x, k) => [X(x), Y(vals[i][k])])), fill: 'none', stroke: s[1], 'stroke-width': s[2], 'stroke-linejoin': 'round' }, f.svg));
    el('circle', { cx: X(st.cut), cy: Y(r.total), r: 5.5, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 2.5 }, f.svg);
    const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', visibility: 'hidden' }, f.svg), ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
    ov.addEventListener('pointermove', (ev) => {
      const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width, s = X.inv(px);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      f.showTip(px * b.width / f.w, ev.clientY - b.top, '<b>Cascades of ' + int(+s.toPrecision(2)) + '+ posts</b>' + row('', 'How many a month', big(pop.N(s)))
        + series.map((q) => row(q[1], q[0], big(CASCADE.plan(pop, opts(Object.assign({ cut: s }, q[3]))).total) + ' units')).join(''));
    });
    ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    legend('c-leg-fit', series.map((s) => ['', s[1], s[0]]));
  }

  function drawFind(pop, r) {
    const f = frame('c-find', 310, 'Chance that the stream flags a cascade, by its size');
    if (!(st.stream > 0)) { document.getElementById('c-leg-find').innerHTML = ''; f.svg.setAttribute('viewBox', '0 0 ' + f.w + ' 10'); return; }
    const m = { l: 44, r: 16, t: 20, b: 42 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t, X = logS(10, 10000, x0, x1), Y = lin(0, 1, y0, y1);
    for (const v of [0, 0.25, 0.5, 0.75, 1]) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, Math.round(100 * v) + '%'); }
    for (const v of [10, 100, 1000, 10000]) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': 'middle', class: 'tick' }, f.svg, int(v)); }
    el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
    el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Cascade size, in posts (log scale)');
    if (st.cut <= 10000) { el('line', { x1: X(st.cut), x2: X(st.cut), y1: y1 - 4, y2: y0, stroke: 'var(--ink)', 'stroke-width': 1.25 }, f.svg); el('text', { x: X(st.cut) - 6, y: y1 + 8, 'text-anchor': 'end', class: 'strong' }, f.svg, int(st.cut) + '+'); }
    const xs = []; for (let i = 0; i <= 120; i++) xs.push(10 * Math.pow(1000, i / 120));
    const hs = [1, 2, 3].includes(st.hits) ? [1, 2, 3] : [1, 3, st.hits];
    hs.forEach((h) => el('path', { d: path(xs.map((x) => [X(x), Y(CASCADE.binomSf(h, Math.round(x), st.stream))])), fill: 'none', stroke: h === st.hits ? 'var(--ink)' : 'var(--ref)', 'stroke-width': h === st.hits ? 2.75 : 1.5, 'stroke-dasharray': h === st.hits ? null : '5 4' }, f.svg));
    const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', visibility: 'hidden' }, f.svg), ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
    ov.addEventListener('pointermove', (ev) => {
      const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width, s = Math.round(X.inv(px));
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      f.showTip(px * b.width / f.w, ev.clientY - b.top, '<b>A cascade of ' + int(s) + ' posts</b>' + row('', 'Posts in the stream, on average', (s * st.stream).toFixed(1)) + hs.map((h) => row(h === st.hits ? 'var(--ink)' : 'var(--ref)', 'Flagged at ' + h + (h === 1 ? ' post' : ' posts'), pct(CASCADE.binomSf(h, s, st.stream)))).join(''));
    });
    ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    legend('c-leg-find', hs.map((h) => ['', h === st.hits ? 'var(--ink)' : 'var(--ref)', 'Flagged at ' + h + (h === 1 ? ' sampled post' : ' sampled posts') + (h === st.hits ? ' (your setting)' : '')]));
  }

  /* ====================================================================== render */
  function render() {
    const pop = CASCADE.population(st), o = opts(), r = CASCADE.plan(pop, o), fits = r.total <= st.cap, sizeTxt = int(st.cut) + '+ posts';
    const reach = CASCADE.reach(pop, o, st.cap), reachTxt = reach == null ? null : int(+reach.toPrecision(2));
    document.getElementById('c-facts').innerHTML = [
      ['Mean size of a 1,000+ cascade', int(pop.mean) + ' posts'],
      ['Cascades of 10,000+ a month', big(pop.N(10000))],
      ['Posts in cascades of 10,000+', pct(pop.P(10000) / pop.P(1000)) + ' of the total'],
      [big(st.nAll) + ' cascades means sizes from', 'about ' + int(+pop.floorOfAll.toPrecision(2)) + ' posts'],
    ].map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
    const pill = document.getElementById('c-pill'); pill.className = 'pill ' + (fits ? 'ok' : 'short'); pill.textContent = fits ? 'Fits the cap' : 'Over the cap';
    const who = r.found < 0.995 ? 'the ' + pct(r.found) + ' of cascades of ' + sizeTxt + ' that the stream flags' : 'every cascade of ' + sizeTxt;
    document.getElementById('c-headline').textContent = fits
      ? 'Collecting ' + low(what()) + ' for ' + who + ' costs ' + big(r.total) + ' units a month, ' + pct(r.total / st.cap) + ' of the cap.'
      : 'Collecting ' + low(what()) + ' for ' + who + ' needs ' + big(r.total) + ' units a month, ' + (r.total / st.cap).toFixed(1) + ' times the cap.';
    document.getElementById('c-recipe').textContent = recipe(r) + (fits ? '' : reachTxt ? ' This plan fits the cap for cascades of about ' + reachTxt + '+ posts.' : ' This plan does not fit the cap at any size.');
    const k = [
      ['Cascades collected a month', big(r.cascades), st.stream > 0 ? pct(r.found) + ' of the ' + big(pop.N(st.cut)) + ' with ' + sizeTxt + ' are flagged' : 'all ' + big(pop.N(st.cut)) + ' with ' + sizeTxt],
      ['Units spent a month', big(r.total), pct(r.total / st.cap) + ' of the cap; ' + big(Math.max(0, st.cap - r.total)) + ' to spare'],
      ['Share of their posts downloaded', pct(r.downloaded / r.allPosts), big(r.downloaded) + ' of ' + big(r.allPosts) + ' posts'],
      st.stream > 0 ? ['Retweets seen in the stream', big(r.sampledRt), 'a ' + (100 * st.stream) + '% sample of ' + big(r.allRt) + ', outside the cap'] : ['Retweets seen in the stream', 'none', 'no stream; totals come from the daily counts'],
    ];
    document.getElementById('c-kpis').innerHTML = k.map(([a, b, s]) => '<div class="kpi"><div class="k">' + a + '</div><div class="v">' + b + '</div><div class="s">' + s + '</div></div>').join('');
    document.getElementById('c-sub-flow').textContent = 'The plan in the headline, step by step, in numbers a month. One unit is the charge for one post.';
    document.getElementById('c-sub-mix').textContent = 'Posts in cascades of ' + sizeTxt + ', by kind. The solid part of each bar is downloaded. Retweets are ' + pct(r.allRt / r.allPosts) + ' of the posts, so they decide what fits.';
    const fitAll = CASCADE.reach(pop, opts({ quotes: true, rtMode: 'all', rtShare: 1 }), st.cap), fitRQ = CASCADE.reach(pop, opts({ quotes: true, rtMode: 'none' }), st.cap);
    document.getElementById('c-sub-fit').textContent = 'Units a month against the smallest cascade collected. Below the cap line fits. Replies and quotes fit from about ' + (fitRQ ? int(+fitRQ.toPrecision(2)) : '?') + '+ posts; every post fits only from about ' + (fitAll ? int(+fitAll.toPrecision(2)) : '?') + '+.';
    document.getElementById('c-sub-find').textContent = st.stream > 0
      ? 'The chance that the ' + streamName() + ' flags a cascade, by its size. A cascade of ' + int(st.cut) + ' posts puts about ' + (st.cut * st.stream).toFixed(st.cut * st.stream < 10 ? 1 : 0) + ' posts in the stream, and its first sampled post is, on average, about its ' + int(Math.round(1 / st.stream)) + 'th.'
      : 'With no stream, cascades are found by searching for roots by repost count, which sees every root that passes the threshold but gives no sample of retweets.';
    document.getElementById('c-foot-build').textContent = 'Cascade view, first version · 19 November 2026. The defaults are the figures given for a three-day window: ' + big(DEFAULTS.n1000) + ' cascades of 1,000+ posts a month holding ' + big(DEFAULTS.p1000) + ' posts, plus ' + big(DEFAULTS.q1000) + ' quotes; 85 to 89% of posts are retweets; a ' + big(DEFAULTS.cap) + ' cap; a 1% stream outside it.';
    drawFlow(pop, r); drawMix(pop, r); drawFit(pop, r); drawFind(pop, r);
  }

  /* ====================================================================== view switch */
  const views = { cascades: document.getElementById('view-cascades'), trees: document.getElementById('view-trees') };
  const tabs = { cascades: document.getElementById('tab-cascades'), trees: document.getElementById('tab-trees') };
  const INTRO = { cascades: 'Set what you know about the cap, the stream and how large cascades are. The results update as you move a control: what fits under the cap, what it costs, and what is left out.',
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
