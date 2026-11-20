/* cascades.js — the cascade view: controls, verdict and figures. Arithmetic is in cascade_model.js.
   To change a default or a label, edit DEFAULTS and GROUPS below, then run build.py. */
(function () {
  'use strict';
  const U = PLANNER.ui, D = CASCADE.DATA, el = U.el, frame = U.frame, lin = U.lin, logS = U.logS, logTicks = U.logTicks, path = U.path, legend = U.legend, row = U.row, big = U.big, pct = U.pct, int = U.int;

  /* ====================================================================== defaults */
  // The population is CASCADE.TABLES (cascade_tables.js): synthetic cascades of 100+ posts, simulated to match the 30 daily summaries for September 2026.
  const DEFAULTS = {
    cap: 1e8,            // units a month
    reserve: 1e7,        // kept back for daily spikes, the largest cascades and lookups
    window: 3,           // days after the root is posted
    month: 'September',  // which measured month the volumes follow
    change: 0,           // change in volume since that month (a 31-day month alone is +3%)
    quoteRooted: true,   // count cascades rooted at a quote as well
    replyLed: true,      // count reply-led cascades (their retweets hang from replies) as well
    full: 10000,         // tier 1: every post, for cascades of at least this many posts
    rqAuto: true, rq: 2500,   // tier 2: replies and quotes; rqAuto sets rq to the lowest size that fits
    rtMode: 'none', rtN: 100, rtRate: 0.03,   // retweets bought for tier 2
    fr: 1000, fd: 100,   // search floors on a root's own retweets and replies; a root passing either is returned
    triage: 'counts', theta: 0.5,   // whose replies are read to size the cascade, and how likely it must look
    passes: 3,           // search passes for each day of roots; the last is at the end of the window
    stream: 0.01,        // the sample stream, outside the cap
  };
  const TIER = { full: 'var(--quiet)', rq: 'var(--root)', bought: 'var(--sample)', census: 'var(--both)', waste: 'var(--ink-3)', reserve: 'var(--ref)' };
  const KIND = ['var(--root)', 'var(--sample)', 'var(--both)'];
  let st = JSON.parse(JSON.stringify(DEFAULTS)), pop = null;
  const sz = (v) => int(v) + ' posts';

  const GROUPS = [
    { title: 'The contract', controls: [
      { key: 'cap', kind: 'log', label: 'Monthly cap, in units', min: 1e7, max: 1e9, fmt: big, hint: 'One unit is the charge for one post returned.' },
      { key: 'reserve', kind: 'range', label: 'Kept in reserve', min: 0, max: 3e7, step: 1e6, fmt: (v) => (v ? big(v) : 'none'), hint: 'For daily spikes, the largest cascades and lookups.' },
      { key: 'window', kind: 'seg', label: 'Window after the root is posted', options: [[1, '1 day'], [2, '2 days'], [3, '3 days'], [7, '7 days']], hint: 'Posts after the window are not collected. Sizes at each window are measured.' },
    ] },
    { title: 'Volumes', controls: [
      { key: 'month', kind: 'seg', label: 'A month like, in 2026', options: [['June', 'Jun'], ['July', 'Jul'], ['August', 'Aug'], ['September', 'Sep']], hint: 'Sizes were measured for September, the largest of the four. The others scale it by their total.' },
      { key: 'change', kind: 'range', label: 'Change in volume since then', min: -0.2, max: 0.5, step: 0.01, fmt: (v) => (v > 0 ? '+' : '') + Math.round(100 * v) + '%', hint: 'Volumes rose about 8% a month from July to September. A 31-day month adds 3%.' },
      { key: 'quoteRooted', kind: 'check', label: 'Count cascades rooted at a quote', hint: 'Measured, as lower bounds: a quote late in its parent’s week was followed for less than seven days.' },
      { key: 'replyLed', kind: 'check', label: 'Count reply-led cascades', hint: 'Cascades whose retweets hang from the replies, not the root: about a quarter of posts in September, from 11% to 35% by day. A sample checked on X shows nearly all are automated advertising: Chinese-language replies selling sexual services, retweeted by automated accounts. Unticked, they are returned by search but not collected.' },
      { kind: 'facts', id: 'c-facts' },
    ] },
    { title: 'What to collect', controls: [
      { key: 'full', kind: 'pick', label: 'Every post, for cascades of at least', choices: [5000, 6000, 7500, 10000, 12500, 15000, 20000, 30000, 50000, Infinity], fmt: (v) => (v === Infinity ? 'no cascade' : sz(v)) },
      { key: 'rqAuto', kind: 'check', label: 'Take replies and quotes as low as fits', hint: 'The lowest size that fits the budget, and no lower than the size at which at least 80% of the tier is found.' },
      { key: 'rq', kind: 'log', label: 'Replies and quotes, for cascades of at least', min: 100, max: 20000, fmt: sz, disabled: () => st.rqAuto },
      { key: 'rtMode', kind: 'seg', label: 'Retweets for those cascades', options: [['none', 'Stream only'], ['first', 'First N'], ['sample', 'Sample']],
        hint: 'The 1% stream shows a random 1% of retweets at no cost. First N and Sample buy more.' },
      { key: 'rtN', kind: 'pick', label: 'Retweets read from each cascade', choices: [50, 100, 250, 500, 1000], fmt: (v) => 'first ' + int(v), disabled: () => st.rtMode !== 'first' },
      { key: 'rtRate', kind: 'range', label: 'Random share of retweets bought', min: 0.01, max: 0.3, step: 0.01, fmt: (v) => Math.round(100 * v) + '%', disabled: () => st.rtMode !== 'sample' },
      { key: 'fr', kind: 'pick', label: 'Search floor on a root’s own retweets', choices: [100, 300, 500, 1000, 2000, 3000, 5000], fmt: (v) => int(v) + ' retweets' },
      { key: 'fd', kind: 'pick', label: 'Search floor on a root’s own replies', choices: [50, 100, 150, 200, 300, 500, Infinity], fmt: (v) => (v === Infinity ? 'not used' : int(v) + ' replies'),
        hint: 'Search returns a root that passes either floor. Reply-led cascades are found only through the floor on replies.' },
      { key: 'triage', kind: 'seg', label: 'Read the replies of', options: [['counts', 'Likely, by counts'], ['stream', 'Likely, by stream'], ['all', 'Every root']],
        hint: 'Replies carry their own counts, so reading them gives a cascade’s size. They cost a unit each even when the cascade turns out too small. By counts: the size is read off the root’s own counts. By stream: off the cascade’s posts in the 1% sample, which needs each sampled post matched to its cascade.' },
      { key: 'theta', kind: 'range', label: 'Likely means an estimated size of at least', min: 0.2, max: 1, step: 0.05, fmt: (v) => Math.round(100 * v) + '% of the second tier', disabled: () => st.triage === 'all' },
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
  const opts = (over) => Object.assign({ full: st.full, rq: st.rq, passes: nPass(), fr: st.fr, fd: st.fd, triage: st.triage, theta: st.theta, rtMode: st.rtMode, rtN: st.rtN, rtRate: st.rtRate, stream: st.stream }, over || {});
  const budget = () => Math.max(0, st.cap - st.reserve);
  const FOUND_MIN = 0.8;   // the automatic second tier stops where search finds less than this share of it
  const roundUp = (v) => { const p = v < 1000 ? 10 : v < 10000 ? 50 : v < 100000 ? 500 : 5000; return Math.ceil(v / p - 1e-9) * p; };
  const top2 = () => (st.full === Infinity ? 1e6 : st.full);
  function derive() {
    pop = CASCADE.population({ scale: D.months[st.month] * (1 + st.change), window: st.window, quoteRooted: st.quoteRooted, replyLed: st.replyLed });
    if (st.rqAuto) {
      // the lowest size that fits, and no lower than search finds: at least FOUND_MIN of the tier
      let e = CASCADE.lowest(pop, opts(), 'rq', budget(), 100, top2());
      if (e != null) { const ok = (v) => { const r = CASCADE.plan(pop, opts({ rq: v })); return r.want2 === 0 || r.found2 >= FOUND_MIN; };
        if (!ok(e)) { let lo = e, hi = top2(); if (ok(hi * 0.999)) { for (let i = 0; i < 30; i++) { const m = Math.sqrt(lo * hi); if (ok(m)) hi = m; else lo = m; } e = hi; } else e = null; } }
      st.rq = e == null ? top2() : Math.min(top2(), roundUp(e));
    }
  }
  const passAges = () => { const end = 24 * st.window, n = nPass(); return n === 1 ? [end] : n === 2 ? [24, end] : [24, 48, end]; };
  const ageTxt = (h) => (h % 24 === 0 && h > 72 ? h / 24 + ' days' : h + ' hours');
  const agesTxt = () => { const a = passAges(); return a.every((h) => h <= 72) ? list(a.map(String)) + ' hours' : list(a.map(ageTxt)); };
  const list = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
  const bought = () => (st.rtMode === 'first' ? 'the first ' + int(st.rtN) + ' retweets of each' : st.rtMode === 'sample' ? 'a random ' + Math.round(100 * st.rtRate) + '% of their retweets' : '');
  const floorsTxt = () => int(st.fr) + ' retweets' + (st.fd === Infinity ? '' : ' or ' + int(st.fd) + ' replies') + ' of their own';
  const bar = (r) => int(roundUp(st.theta * r.rq));
  function recipe(r, hasT1, hasT2) {
    const parts = ['Each day, search for roots posted ' + agesTxt() + ' earlier that have at least ' + floorsTxt() + '.',
      st.triage === 'all' ? 'Read the replies of every root returned: each reply carries its own counts, and their sum is the cascade’s size.'
        : st.triage === 'stream' ? 'Where the 1% stream holds enough of a cascade’s posts to suggest ' + bar(r) + '+ posts, read its replies: each carries its own counts, and their sum is the cascade’s size.'
        : 'Where a root’s counts suggest a cascade of ' + bar(r) + '+ posts, read its replies: each carries its own counts, and their sum is the cascade’s size.'];
    if (hasT1) parts.push('For cascades of ' + int(st.full) + '+ posts, fetch every quote and retweet.');
    if (hasT2) parts.push('For cascades of ' + int(r.rq) + '+ posts, fetch the quotes' + (st.rtMode === 'none' ? '; their retweets come from the 1% stream only.' : ' and ' + bought() + '.'));
    parts.push('This finds ' + pct(r.found) + ' of the cascades wanted. Check what search found against the 1% stream.');
    return parts.join(' ');
  }

  /* ====================================================================== figures */
  function drawFlow(r, hasT1, hasT2, fits) {
    const host = document.getElementById('c-flow'), wide = host.clientWidth >= 820, BH = 90, uid = 'cf' + (drawFlow.n = (drawFlow.n || 0) + 1);
    const col = fits ? 'var(--ok)' : 'var(--over)';
    const how = st.triage === 'all' ? 'every root returned' : st.triage === 'stream' ? 'likely ones, by stream' : 'likely ones, by counts';
    const boxes = [
      { title: 'Search by counts', color: TIER.census, lines: [nPass() === 1 ? 'one pass, at ' + ageTxt(passAges()[0]) : 'at ' + (st.window <= 3 ? agesTxt() : passAges().map((h) => (h > 72 ? h / 24 + ' d' : h + ' h')).join(', ')), big(r.roots) + ' roots returned', 'costs ' + big(r.finding) + ' units'] },
      { title: 'Read replies to size', color: TIER.waste, lines: [how, big(r.sized) + ' cascades sized', big(r.waste) + ' units on small ones'] },
      hasT1 ? { title: 'In full, ' + int(st.full) + '+', color: TIER.full, lines: ['every post', big(r.n1 + r.q1) + ' cascades', 'costs ' + big(r.cost1) + ' units'] }
            : { title: 'No cascade in full', dashed: true, lines: ['no size chosen', 'for every post', 'costs nothing'] },
      hasT2 ? { title: 'Replies, quotes, ' + int(r.rq) + '+', color: TIER.rq, lines: [st.rtMode === 'none' ? 'retweets: 1% stream only' : st.rtMode === 'first' ? 'and first ' + int(st.rtN) + ' retweets' : 'and ' + Math.round(100 * st.rtRate) + '% of retweets', big(r.n2 + r.q2) + ' cascades', 'costs ' + big(r.cost2 + r.bought) + ' units'] }
            : { title: 'No second tier', dashed: true, lines: hasT1 ? ['nothing below', 'the cascades in full', 'costs nothing'] : ['nothing fits', 'under this cap', 'costs nothing'] },
      { title: 'Collected', color: col, fill: true, lines: [big(r.n1 + r.q1 + r.n2 + r.q2) + ' cascades a month', pct(r.found) + ' of those wanted', big(r.total) + ' units, ' + pct(r.total / st.cap) + ' of cap'] },
    ];
    const f = frame('c-flow', wide ? BH + 34 : boxes.length * BH + (boxes.length - 1) * 24 + 10, 'The plan as a flow: search by counts, replies read to size, each tier, result');
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
    const segs = [['Cascades in full', r.cost1, TIER.full], ['Replies and quotes', r.cost2, TIER.rq], ['Retweets bought', r.bought, TIER.bought], ['Replies of cascades too small', r.waste, TIER.waste], ['Search by counts', r.finding, TIER.census], ['Reserve', st.reserve, TIER.reserve]].filter((x) => x[1] > 0);
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
    if (hasT1) rows.push(['In full', int(st.full) + '+ posts', r.A, r.cost1, TIER.full, r.n1 + r.q1, pct(r.found1) + ' of ' + big(r.want1) + ' found']);
    if (hasT2) rows.push(['Replies and quotes', int(r.rq) + ' to ' + (st.full === Infinity ? 'the largest' : int(st.full - 1)), r.B, r.cost2 + r.bought, TIER.rq, r.n2 + r.q2, pct(r.found2) + ' of ' + big(r.want2) + ' found' + (st.rtMode === 'none' ? '' : ', with ' + big(r.bought) + ' retweets')]);
    if (!rows.length) rows.push(['Nothing collected', 'no tier chosen', 1, 0, TIER.reserve, 0, '']);
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
      hit.addEventListener('pointermove', (ev) => { const b = f.svg.getBoundingClientRect(); f.showTip(ev.clientX - b.left, ev.clientY - b.top, '<b>' + name + ' · ' + range + '</b>' + row('', 'Cascades found a month', big(n)) + row('', 'Posts in the tier, found or not', big(all)) + row(col, 'Downloaded', big(got) + ' · ' + pct(all ? got / all : 0))); });
      hit.addEventListener('pointerleave', f.hideTip);
    });
    el('line', { x1: x0, x2: x1, y1: yb, y2: yb, stroke: 'var(--line-2)' }, f.svg);
    const step = U.niceStep(max / 4);
    for (let v = 0; v <= max * 1.001; v += step) { el('line', { x1: X(v), x2: X(v), y1: yb, y2: yb + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: yb + 18, 'text-anchor': v === 0 ? 'start' : 'middle', class: 'tick' }, f.svg, v === 0 ? '0' : big(v)); }
    el('text', { x: x1, y: f.h - 2, 'text-anchor': 'end' }, f.svg, 'posts a month');
    legend('c-leg-mix', [['box', 'var(--ink-2)', 'Downloaded'], ['box', 'var(--ink-2)', 'In the tier, not downloaded or not found', 'opacity:.2']]);
  }

  function drawFit(r, hasT2) {
    const f = frame('c-fit', 330, 'Units a month against the smallest cascade collected');
    const m = { l: 46, r: 16, t: 20, b: 42 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t, lo = 100, hi = 100000;
    const every = (s) => pop.P(s), rq = (s) => pop.RQ(s), mine = (s) => CASCADE.plan(pop, opts({ rq: s })).total;
    const xs = []; for (let i = 0; i <= 120; i++) xs.push(lo * Math.pow(hi / lo, i / 120));
    const mineXs = xs.filter((x) => x <= top2());
    const all = xs.map(every).concat(xs.map(rq), [st.cap]), X = logS(lo, hi, x0, x1), Y = logS(Math.min.apply(null, all) / 1.4, Math.max.apply(null, all) * 1.4, y0, y1);
    el('rect', { x: x0, y: y1, width: x1 - x0, height: Math.max(0, Y(st.cap) - y1), fill: 'var(--over)', 'fill-opacity': 0.05 }, f.svg);
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
      f.showTip(px * b.width / f.w, ev.clientY - b.top, '<b>Cascades of ' + int(s) + '+ posts</b>' + row('', 'How many a month', big(pop.N(s)))
        + row(TIER.full, 'Every post', big(every(s)) + ' units') + row(TIER.rq, 'Replies and quotes', big(rq(s)) + ' units')
        + (s <= top2() ? row('var(--ink)', 'Your plan, second tier from here', big(mine(s)) + ' units') : ''));
    });
    ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    legend('c-leg-fit', [['', TIER.full, 'Every post, from this size up'], ['', TIER.rq, 'Replies and quotes, from this size up'], ['', 'var(--ink)', 'Your plan, as its second tier reaches lower'], ['dot', 'var(--ink-2)', 'At 1,000, 5,000, 10,000 and 20,000 posts']]);
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
    const f = frame('c-find', 310, 'Share of cascades returned by search and sized, by size, with the chance that the 1% stream samples at least one post');
    const m = { l: 44, r: 16, t: 24, b: 42 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t, LO = 100, HI = 100000, X = logS(LO, HI, x0, x1), Y = lin(0, 1, y0, y1);
    for (const v of [0, 0.25, 0.5, 0.75, 1]) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, Math.round(100 * v) + '%'); }
    for (const v of [100, 1000, 10000, 100000]) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': v === HI ? 'end' : 'middle', class: 'tick' }, f.svg, int(v)); }
    el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
    el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Cascade size, in posts (log scale)');
    const edges = []; for (let i = 0; i <= 12; i++) edges.push(LO * Math.pow(HI / LO, i / 12)); edges[12] = 1e9;
    const o = opts(), bands = CASCADE.foundBySize(pop, Object.assign({}, o, { rq: Math.min(o.rq, o.full) }), edges).filter((b) => b.found != null), mid = (b) => Math.sqrt(b.lo * Math.min(b.hi, HI));
    const xs = []; for (let i = 0; i <= 90; i++) xs.push(LO * Math.pow(HI / LO, i / 90));
    el('path', { d: path(xs.map((x) => [X(x), Y(CASCADE.binomSf(1, Math.round(x), st.stream))])), fill: 'none', stroke: 'var(--ref)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, f.svg);
    const series = [['returned', TIER.census, 2, 'Returned by search'], ['found', 'var(--ink)', 2.75, 'Returned and sized']];
    series.forEach(([k, col, w]) => { el('path', { d: path(bands.map((b) => [X(mid(b)), Y(b[k])])), fill: 'none', stroke: col, 'stroke-width': w, 'stroke-linejoin': 'round' }, f.svg);
      bands.forEach((b) => el('circle', { cx: X(mid(b)), cy: Y(b[k]), r: 3.5, fill: col, stroke: 'var(--surface)', 'stroke-width': 2 }, f.svg)); });
    if (st.rq < top2()) { el('line', { x1: X(st.rq), x2: X(st.rq), y1: y1, y2: y0, stroke: TIER.rq, 'stroke-dasharray': '2 4' }, f.svg); el('text', { x: X(st.rq) + 6, y: y0 - 8, style: 'fill:var(--ink)' }, f.svg, 'second tier from ' + int(st.rq)); }
    const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', visibility: 'hidden' }, f.svg), ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
    ov.addEventListener('pointermove', (ev) => {
      const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width; let j = 0; bands.forEach((q, i) => { if (Math.abs(X(mid(q)) - px) < Math.abs(X(mid(bands[j])) - px)) j = i; });
      const q = bands[j]; if (!q) return;
      cross.setAttribute('x1', X(mid(q))); cross.setAttribute('x2', X(mid(q))); cross.setAttribute('visibility', 'visible');
      f.showTip(X(mid(q)) * b.width / f.w, ev.clientY - b.top, '<b>Cascades of ' + int(roundUp(q.lo)) + (q.hi > HI ? '+' : ' to ' + int(roundUp(q.hi))) + ' posts</b>' + row('', 'How many a month', big(q.n))
        + row(TIER.census, 'Returned by search', pct(q.returned)) + row('var(--ink)', 'Returned and sized', pct(q.found)) + row('var(--ref)', 'Stream samples a post', pct(CASCADE.binomSf(1, Math.round(mid(q)), st.stream))));
    });
    ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    legend('c-leg-find', [['', TIER.census, 'Returned by search'], ['', 'var(--ink)', 'Returned and sized'], ['', 'var(--ref)', '1% stream samples at least one post']]);
  }

  /* ====================================================================== render */
  function render() {
    if (!pop) derive();
    const hasT1 = st.full !== Infinity, hasT2 = st.rq < top2(), r = CASCADE.plan(pop, opts(hasT2 ? {} : { rq: Infinity })), fits = r.total <= budget() + 1, c1 = r.n1 + r.q1, c2 = r.n2 + r.q2;
    document.getElementById('c-facts').innerHTML = [
      ['Cascades of 1,000+ a month', big(pop.NA(1000))],
      ['Posts in them', big(pop.P(1000))],
      ['Replies and quotes among those posts', pct(pop.RQ(1000) / pop.P(1000))],
      ['Cascades of 10,000+ a month', big(pop.NA(10000))],
      ['Their share of those posts', pct(pop.P(10000) / pop.P(1000))],
      ['Cascades of 100+ a month', big(pop.NA(100))],
    ].concat(st.quoteRooted ? [['Of the 1,000+, rooted at a quote', big(pop.NQ(1000))]] : [], st.replyLed ? [['Posts at 1,000+ in reply-led cascades', pct(pop.LedPosts(1000) / pop.P(1000))]] : []).map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
    const pill = document.getElementById('c-pill'); pill.className = 'pill ' + (fits ? 'ok' : 'short'); pill.textContent = fits ? 'Fits the cap' : 'Over the cap';
    const rqWords = st.rtMode === 'first' ? 'replies, quotes and first ' + int(st.rtN) + ' retweets' : st.rtMode === 'sample' ? 'replies, quotes and a random ' + Math.round(100 * st.rtRate) + '% of the retweets' : 'replies and quotes';
    const subject = hasT1 && hasT2 ? 'Every post of ' + big(c1) + ' cascades of ' + int(st.full) + '+ posts, and the ' + rqWords + ' of ' + big(c2) + ' more down to ' + int(r.rq) + ' posts,'
      : hasT1 ? 'Every post of ' + big(c1) + ' cascades of ' + int(st.full) + '+ posts'
      : hasT2 ? 'The ' + rqWords + ' of ' + big(c2) + ' cascades of ' + int(r.rq) + '+ posts'
      : 'Search by counts alone';
    const plural = hasT2;
    document.getElementById('c-headline').textContent = subject + (fits ? (plural ? ' cost ' : ' costs ') + big(r.total) + ' units a month, ' + pct(r.total / st.cap) + ' of the cap.'
      : (plural ? ' need ' : ' needs ') + big(r.total) + ' units a month, ' + (budget() > 0 ? 'more than the ' + big(budget()) + ' available.' : 'and the reserve takes the whole cap.'));
    let fix = '';
    if (!fits) {
      const e = CASCADE.lowest(pop, opts(), 'rq', budget(), 100, top2()), g = CASCADE.lowest(pop, opts({ rq: Infinity }), 'full', budget(), 1000, 1e6);
      fix = e != null ? ' Replies and quotes fit from about ' + int(roundUp(e)) + '+ posts.' : g != null ? ' Every post alone fits only from about ' + int(roundUp(g)) + '+ posts.' : '';
    }
    if (st.window < 7) fix += ' A ' + ['', 'one', 'two', 'three'][st.window] + '-day window holds ' + pct(pop.share) + ' of the posts these cascades have in seven days, and ' + pct(D.passed10k[24 * st.window]) + ' of the seven-day cascades of 10,000+ reach 10,000 in it.';
    document.getElementById('c-recipe').textContent = recipe(r, hasT1, hasT2) + fix;
    const k = [
      ['Cascades collected in full', hasT1 ? big(c1) : 'none', hasT1 ? int(st.full) + '+ posts; ' + big(r.cost1) + ' units; ' + pct(r.found1) + ' of them found' : 'no size chosen'],
      [st.rtMode === 'none' ? 'With replies and quotes only' : 'With replies, quotes and some retweets', hasT2 ? big(c2) : 'none', hasT2 ? 'down to ' + int(r.rq) + ' posts; ' + big(r.cost2 + r.bought) + ' units; ' + pct(r.found2) + ' of them found' : 'no second tier'],
      ['Units spent a month', big(r.total), pct(r.total / st.cap) + ' of the cap' + (st.reserve ? '; ' + big(st.reserve) + ' in reserve' : '')],
      ['Spent finding and sizing', big(r.finding + r.waste), big(r.roots) + ' roots returned; ' + big(r.waste) + ' units on replies of cascades too small'],
    ];
    document.getElementById('c-kpis').innerHTML = k.map(([a, b, s]) => '<div class="kpi"><div class="k">' + a + '</div><div class="v">' + b + '</div><div class="s">' + s + '</div></div>').join('');
    document.getElementById('c-sub-flow').textContent = 'The plan in the headline, step by step, in numbers a month. One unit is the charge for one post returned.';
    document.getElementById('c-sub-mix').textContent = 'The bar shows where the cap goes. Below it, each tier’s posts, with the downloaded part solid. Retweets are ' + pct(1 - pop.RQ(1000) / pop.P(1000)) + ' of the posts in cascades of 1,000+, so collecting them for every cascade is what does not fit.';
    const fitAll = CASCADE.lowest(pop, opts({ rq: Infinity, found: 'all' }), 'full', st.cap, 1000, 1e6), fitRQ = CASCADE.lowest(pop, opts({ full: Infinity, found: 'all' }), 'rq', st.cap, 100, 1e6);
    document.getElementById('c-sub-fit').textContent = 'Units a month against the smallest cascade collected, if every cascade were found at no cost. On that footing every post fits the cap from about ' + (fitAll ? int(roundUp(fitAll)) : '?') + '+ posts, and replies and quotes from about ' + (fitRQ ? int(roundUp(fitRQ)) + '+' : '?') + '. The black line is your plan, with finding and sizing counted, as its second tier reaches lower.';
    document.getElementById('c-sub-grow').textContent = 'Median share of a cascade’s seven-day size reached by each hour. The median cascade has about 99% of it at 48 hours. Of the cascades that end at 10,000+ posts, ' + pct(D.passed10k[24]) + ' have passed 10,000 by 24 hours, ' + pct(D.passed10k[48]) + ' by 48 and ' + pct(D.passed10k[72]) + ' by 72.';
    document.getElementById('c-sub-find').textContent = 'By cascade size: the share that search returns with these floors, and the share whose replies are then read. A cascade is missed when its size sits on its replies and the root stays under both floors, or when the root’s counts make it look too small to size. The grey line is the chance that the 1% stream samples at least one of its posts.';
    document.getElementById('c-foot-build').textContent = 'Cascade view, fifth version · 20 November 2026. Sizes, replies and quotes were counted by Prof. Toyoda’s group on the full Japanese stream for September 2026: ' + int(D.main.n100) + ' cascades of 100+ posts rooted at an original post, holding ' + big(D.main.posts100) + ' posts, and ' + int(D.quote.n100) + ' rooted at a quote. The page works on simulated cascades that match those counts; no row is a real cascade. Root counts and the reply-led class come from models fitted to the two days for which every post is on file.';
    drawFlow(r, hasT1, hasT2, fits); drawCap(r, fits); drawTiers(r, hasT1, hasT2); drawFit(r, hasT2); drawGrow(); drawFind();
  }

  /* ====================================================================== view switch */
  const views = { cascades: document.getElementById('view-cascades'), trees: document.getElementById('view-trees') };
  const tabs = { cascades: document.getElementById('tab-cascades'), trees: document.getElementById('tab-trees') };
  const INTRO = { cascades: 'Cascade sizes are measured counts for September 2026. Set the cap, how cascades are found and the two sizes; the results update as you move a control: what fits under the cap, what it costs, and what is missed.',
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
