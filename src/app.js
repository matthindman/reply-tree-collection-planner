/* app.js — controls, live results and charts for the Reply Tree Collection Planner.
   To change a default, a label or a preset, edit CONFIG and GROUPS below, then run build.py. */
(function () {
  'use strict';
  const E = GRT.EDGES, NB = GRT.NB;

  /* ====================================================================== CONFIG */
  const CONFIG = {
    version: 'Draft 13 · 19 November 2026',
    // Fitted parameters of the reply-tree model (general_model/fits). Japan 2011 is the default.
    models: {
      // Best guess for Japanese X today: a full parameter set calibrated to the prior assessments (data/calibrate_today.js).
      today: { label: 'Best guess', table: 'today', params: (typeof SCENARIO_TABLES !== 'undefined' && SCENARIO_TABLES.today) ? SCENARIO_TABLES.today.params : null },
      // The Opus analysis's own preset: the same sizes, more root-driven.
      opus: { label: 'Opus', table: 'opus', params: (typeof SCENARIO_TABLES !== 'undefined' && SCENARIO_TABLES.opus) ? SCENARIO_TABLES.opus.params : null },
      japan2011: { label: 'Japan 2011', table: 'japan2011',
        params: { w: 0.5655484, a1: 1.5781099, t1: 1.2234419, a2: 2.0912357, t2: 0.0100002, alpha0: 3.9668806, b1: 0.0347892, b2: 0.035352,
                  c0: 0.8176346, c1: 1.4687561, s1: 1.783306, g0: -2.7786261, mu: -0.527664, gam: 0.3392188, sig: 0.9014904, tau: 0.3806759, f0: -2.1083761, f1: -0.4869628 } },
      usNews: { label: 'US news',
        params: { w: 0.5748, a1: 1.5034, t1: 0.4431, a2: -1.5269, t2: 0.6615, alpha0: 3.318, b1: 0.5088, b2: 0.1176,
                  c0: -2.1477, c1: 0.1574, s1: 0.102, g0: -3.2205, mu: -0.6145, gam: 0.0299, sig: 0.7028, tau: 0.4709, f0: -1.5448, f1: 0.2521 } },
      usMidterms: { label: 'US midterms',
        params: { w: 0.4096, a1: 2.0522, t1: 0.0112, a2: 0.382, t2: 0.2644, alpha0: 2.58, b1: 0.3764, b2: 0.0932,
                  c0: -1.7727, c1: 0.1905, s1: 0.6683, g0: -2.8621, mu: -0.5477, gam: 0.0528, sig: 0.6081, tau: 0.4617, f0: -0.79, f1: 0.1483 } },
    },
    defaults: {
      base: 'japan2011', mix: 0, pop: 1, lam: 1, dMu: 0, sigScale: 1, dC0: 0, dBranch: 0, params: null,
      replies: 5e8,      // Japanese replies a month: an estimate, not a measurement
      quota: 5e7,        // posts a month: press-reported Enterprise package size, not our contract
      stream: 'none', minReplies: 'direct', countPrice: 2, streamPrice: 1,
      rootDays: 2, reread: 1, expansions: 0, requestFee: 0, traffic: 1,
      cut: 100, recall: 0.9, allowRoot: true, allowSample: true, cap: 0,
    },
    // One-click scenarios. Each sets the population controls; `table` names a precomputed population
    // (src/ref_tables.js, src/scenario_tables.js) so it loads at once. The four prior scenarios are calibrated
    // to two desk reviews of late-2026 Japanese X (data/scenarios.json, data/make_scenarios.js).
    scenarios: {
      today: { label: 'Best guess for Japanese X today', table: 'today', primary: true, set: { mix: 0, replies: 5e8 }, note: 'A working guess, not a measurement: GPT Pro\u2019s settings. Both desk reviews put about 12% of replies in conversations of 100+ posts. They differ on how many of those are quiet-root; these settings take the higher figure.' },
      low: { label: 'Low end', table: 'low', set: { mix: 0 }, note: 'Best guess with fewer popular roots, so 3.4% of replies sit in conversations of 100+ posts, near the low end of the reviews\u2019 ranges. More of them are quiet-root.' },
      high: { label: 'High end', table: 'high', set: { mix: 0 }, note: 'Best guess with more popular roots, so 32% of replies sit in conversations of 100+ posts, near the high end of the reviews\u2019 ranges. Fewer of them are quiet-root.' },
      quiet: { label: 'Quiet-root', table: 'quiet', set: { mix: 0 }, note: 'Best guess with exchanges that vary more in length: 36% of conversations of 100+ posts are quiet-root.' },
      opus: { label: 'Root-driven', table: 'opus', set: { mix: 0 }, note: 'Claude Opus\u2019s settings: similar concentration, but 87% of conversations of 100+ posts are root-driven.' },
      japan2011: { label: 'Japan 2011', table: 'japan2011', set: { mix: 0 }, note: 'The model fitted to the published 2011 curves.' },
      usArchives: { label: 'US archives', table: 'japan2011', set: { mix: 100 }, note: 'The US news and election archives, selected by topic and account.' },
    },
    startScenario: 'today',
    sim: { rounds: 8, budget: 2.5e6, seed: 20261119 },
    cutChoices: E.filter((e) => e >= 20 && e <= 20000),
    capChoices: [0, 500, 1000, 2000, 5000, 10000, 20000, 50000],
  };
  const FAM = {
    root: { name: 'Root search', color: 'var(--root)' },
    sample: { name: 'Reply sample', color: 'var(--sample)' },
    both: { name: 'Root search + sample', color: 'var(--both)' },
  };
  const FAMS = ['root', 'sample', 'both'];

  /* ====================================================================== formatting */
  const big = (n) => {
    if (!isFinite(n)) return '–';
    const a = Math.abs(n), two = (v) => (Math.abs(v) < 9.95 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v)));
    if (a >= 999.5e6) return two(n / 1e9) + 'B';
    if (a >= 999.5e3) return two(n / 1e6) + 'M';
    if (a >= 9950) return Math.round(n / 1e3) + 'k';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    if (a >= 100) return String(Math.round(n));
    if (a >= 10) return n.toFixed(0);
    return n.toPrecision(2).replace(/\.0+$/, '');
  };
  const pct = (x) => {
    if (x == null || !isFinite(x)) return '–';
    const v = 100 * x, a = Math.abs(v);
    if (a >= 99.5 && a < 100) return (Math.floor(v * 10) / 10).toFixed(1) + '%';
    if (a >= 10) return v.toFixed(0) + '%';
    if (a >= 1) return v.toFixed(1) + '%';
    if (a >= 0.1) return v.toFixed(2) + '%';
    if (a < 0.0005) return '0%';
    return v.toPrecision(1) + '%';
  };
  const int = (n) => Math.round(n).toLocaleString('en-US');
  const ord = (h) => h + (h % 10 === 1 && h !== 11 ? 'st' : h % 10 === 2 && h !== 12 ? 'nd' : h % 10 === 3 && h !== 13 ? 'rd' : 'th');
  const logistic = (z) => 1 / (1 + Math.exp(-z));

  /* ====================================================================== state */
  const KNOBS0 = { pop: 1, lam: 1, dMu: 0, sigScale: 1, dC0: 0, dBranch: 0 };
  const scenarioSet = (name) => { const sc = CONFIG.scenarios[name], t = (typeof SCENARIO_TABLES !== 'undefined' && SCENARIO_TABLES[sc.table]) || null;
    return Object.assign({ base: t ? t.base : 'japan2011', params: null }, KNOBS0, t ? t.knobs : {}, sc.set); };
  const freshState = () => Object.assign(JSON.parse(JSON.stringify(CONFIG.defaults)), scenarioSet(CONFIG.startScenario));
  let state = freshState();
  const POP_KEYS = new Set(['base', 'pop', 'lam', 'dMu', 'sigScale', 'dC0', 'dBranch', 'params']);
  const baseParams = () => Object.assign({}, CONFIG.models[state.base].params || CONFIG.models.japan2011.params, state.params || {});
  function modelParams() {
    const p = baseParams();
    p.w = 1 - Math.min(0.95, Math.max(0.001, (1 - p.w) * state.pop));     // must match applyKnobs() in data/make_scenarios.js
    p.t1 /= state.lam; p.a1 /= state.lam; p.t2 /= state.lam; p.a2 /= state.lam;
    p.mu += state.dMu; p.sig *= state.sigScale; p.c0 += state.dC0; p.f0 += state.dBranch; p.g0 += state.dBranch;
    return p;
  }
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  /* The precomputed table whose population settings equal the current ones, if any. */
  function matchTable() {
    if (state.params) return null;
    for (const name in CONFIG.scenarios) { const t = scenarioSet(name); if (t.base === state.base && Object.keys(KNOBS0).every((k) => near(t[k], state[k]))) return CONFIG.scenarios[name].table; }
    return null;
  }
  const activeScenario = () => { for (const name in CONFIG.scenarios) { const t = scenarioSet(name); if (!state.params && t.base === state.base && near(t.mix, state.mix) && Object.keys(KNOBS0).every((k) => near(t[k], state[k]))) return name; } return null; };
  const knobsNeutral = () => matchTable() === 'japan2011';

  /* ====================================================================== controls */
  const GROUPS = [
    { title: 'Scenario', controls: [{ kind: 'scenario' }] },
    { title: 'Conversations on Japanese X', controls: [
      { key: 'base', kind: 'seg', label: 'Start from', options: [['today', 'Best guess'], ['opus', 'Opus'], ['japan2011', 'Japan \u201911'], ['usNews', 'US news'], ['usMidterms', 'Midterms']],
        hint: 'Best guess and Opus come from the two desk reviews. The other three are the model fitted to 2011 Japanese data and to two US topic archives.' },
      { key: 'mix', kind: 'range', label: 'Replies from US-archive-style conversations', min: 0, max: 100, step: 1, fmt: (v) => v + '%',
        hint: 'Blends in conversations like those in the US news and election archives, which very popular posts dominate.' },
      { key: 'pop', kind: 'log', label: 'Roots that can draw many replies', min: 0.1, max: 6, fmt: () => pct(Math.min(0.95, Math.max(0.001, (1 - baseParams().w) * state.pop))),
        hint: 'Share of roots in the popular group. This control moves replies into large conversations more than any other.' },
      { key: 'lam', kind: 'range', label: 'Reach of the most popular posts', min: 0.6, max: 1.4, step: 0.02, fmt: (v) => '×' + v.toFixed(2),
        hint: 'Higher makes the most popular roots draw even more direct replies.' },
      { key: 'dC0', kind: 'range', label: 'Direct replies that get an answer', min: -3, max: 2, step: 0.05, fmt: () => pct(answerParts(modelParams(), 1, 0, true).any),
        hint: 'Chance of at least one reply, under a root with one reply, in a typical conversation.' },
      { key: 'dMu', kind: 'range', label: 'Later replies that get an answer', min: -1.5, max: 2, step: 0.05, fmt: () => pct(answerParts(modelParams(), 1, 0, false).any),
        hint: 'The same chance for a reply to another reply. Higher means longer exchanges.' },
      { key: 'sigScale', kind: 'range', label: 'Spread in persistence', min: 0.4, max: 1.6, step: 0.02, fmt: (v) => '×' + v.toFixed(2),
        hint: 'How much longer exchanges run in some conversations than in others.' },
      { key: 'dBranch', kind: 'range', label: 'Side threads', min: -1.5, max: 1.5, step: 0.05, fmt: () => pct(answerParts(modelParams(), 1, 0, false).phi),
        hint: 'Chance that an exchange splits into several when it ends.' },
      { kind: 'facts', id: 'facts-pop' },
      { kind: 'params' },
    ] },
    { title: 'Scale and quota', controls: [
      { key: 'replies', kind: 'log', label: 'Replies a month', min: 5e7, max: 3e9, fmt: big, hint: 'Replies in conversations under Japanese roots. Unknown: the default is an estimate of Japanese-written replies, which is not quite the same thing.' },
      { key: 'quota', kind: 'log', label: 'Monthly quota, in units', min: 1e6, max: 1e9, fmt: big, hint: 'One unit is the charge for one post. Unknown: the default is a press-reported package size.' },
      { kind: 'facts', id: 'facts-scale' },
    ] },
    { title: 'The contract', controls: [
      { key: 'stream', kind: 'seg', label: 'A reply stream outside the quota', options: [['none', 'None'], ['s1', '1%'], ['s10', '10%'], ['full', 'Full']],
        hint: 'A free feed of replies (1%, 10% or all) that does not count against the quota. Assumed to carry every reply in a conversation, in any language.' },
      { key: 'minReplies', kind: 'seg', label: 'Root search threshold counts', options: [['direct', 'Direct replies'], ['all', 'All replies below']],
        hint: 'Whether X\u2019s reply-count search filter counts only direct replies or every reply below the root. X does not say; direct replies is the best guess.' },
      { key: 'countPrice', kind: 'range', label: 'Price of one count request', min: 0, max: 20, step: 0.5, fmt: (v) => v + (v === 1 ? ' unit' : ' units'),
        hint: 'Set to 0 if counts do not draw on the quota.' },
      { key: 'streamPrice', kind: 'range', label: 'Price of a bought stream post', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) + (v === 1 ? ' unit' : ' units'), disabled: () => state.stream !== 'none' },
      { kind: 'more', title: 'More billing assumptions', controls: [
        { key: 'rootDays', kind: 'range', label: 'Days a root is billed by search', min: 1, max: 30, step: 1, fmt: (v) => v + (v === 1 ? ' day' : ' days') },
        { key: 'reread', kind: 'range', label: 'Times each post is billed', min: 1, max: 3, step: 0.1, fmt: (v) => '×' + v.toFixed(1) },
        { key: 'expansions', kind: 'range', label: 'Extra billed objects per post (users, media)', min: 0, max: 3, step: 0.1, fmt: (v) => '+' + v.toFixed(1) },
        { key: 'requestFee', kind: 'range', label: 'Fee per search request', min: 0, max: 50, step: 1, fmt: (v) => v + ' units' },
        { key: 'traffic', kind: 'range', label: 'Stream posts paid for per reply sampled', min: 1, max: 10, step: 0.5, fmt: (v) => '×' + v },
      ] },
    ] },
    { title: 'Research choices', controls: [
      { key: 'cut', kind: 'pick', label: 'Collect conversations of at least', choices: CONFIG.cutChoices, fmt: (v) => int(v) + ' posts' },
      { key: 'recall', kind: 'range', label: 'Share of them that must be found', min: 0.5, max: 0.99, step: 0.01, fmt: (v) => Math.round(100 * v) + '%' },
      { kind: 'checks', label: 'Ways of finding them', items: [['allowRoot', 'Root search'], ['allowSample', 'Reply sample']] },
      { key: 'cap', kind: 'pick', label: 'Of each conversation, read', choices: CONFIG.capChoices, fmt: (v) => (v ? 'first ' + int(v) + ' posts' : 'everything'),
        hint: 'Reading only the first posts of each conversation lets the quota cover more conversations, but leaves the largest ones incomplete.' },
    ] },
  ];

  const rail = document.getElementById('rail');
  const refreshers = [];
  function buildControls() {
    rail.textContent = ''; refreshers.length = 0;
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const addCtl = (host, c) => {
      if (c.kind === 'facts') { const dl = mk('dl', 'facts'); dl.id = c.id; host.appendChild(dl); return; }
      if (c.kind === 'scenario') {
        const g = mk('div', 'scen'), note = mk('div', 'hint'); note.id = 'scen-note';
        const btns = Object.keys(CONFIG.scenarios).map((name) => {
          const b = mk('button', CONFIG.scenarios[name].primary ? 'primary' : null); b.type = 'button'; b.appendChild(mk('b', null, CONFIG.scenarios[name].label)); const sh = mk('span', 'num'); b.appendChild(sh);
          b.addEventListener('click', () => applyScenario(name)); g.appendChild(b); return [name, b, sh];
        });
        host.appendChild(g); host.appendChild(note);
        refreshers.push(() => { const act = activeScenario(); btns.forEach(([name, b, sh]) => { b.setAttribute('aria-pressed', String(name === act)); sh.textContent = pct(scenarioShare(name)); });
          note.textContent = act ? CONFIG.scenarios[act].note : 'Custom settings. Each number above is the share of replies in conversations of 100+ posts.'; });
        return;
      }
      if (c.kind === 'more') {
        const d = mk('details', 'more'); d.appendChild(mk('summary', null, c.title));
        c.controls.forEach((x) => addCtl(d, x)); host.appendChild(d); return;
      }
      if (c.kind === 'params') {
        const d = mk('details', 'more'); d.appendChild(mk('summary', null, 'All 18 model parameters'));
        const g = mk('div', 'params');
        const inputs = {};
        Object.keys(CONFIG.models.japan2011.params).forEach((k) => {
          const l = mk('label', null, k), i = mk('input'); i.type = 'number'; i.step = 'any'; i.id = 'p-' + k;
          i.addEventListener('change', () => { const v = parseFloat(i.value); if (!isFinite(v)) return; state.params = Object.assign({}, state.params || {}, { [k]: v }); changed('params'); });
          l.appendChild(i); g.appendChild(l); inputs[k] = i;
        });
        d.appendChild(g); host.appendChild(d);
        refreshers.push(() => { const p = baseParams(); for (const k in inputs) if (document.activeElement !== inputs[k]) inputs[k].value = +p[k].toPrecision(6); });
        return;
      }
      const wrap = mk('div', 'ctl'), head = mk('div', 'ctl-head');
      const lab = mk(c.kind === 'range' || c.kind === 'log' || c.kind === 'pick' ? 'label' : 'span', 'lab', c.label), val = mk('span', 'val');
      head.appendChild(lab); head.appendChild(val); wrap.appendChild(head);
      if (c.kind === 'range' || c.kind === 'log' || c.kind === 'pick') {
        const r = mk('input'); r.type = 'range'; r.id = 'c-' + c.key; lab.htmlFor = r.id;
        if (c.kind === 'range') { r.min = c.min; r.max = c.max; r.step = c.step; }
        else if (c.kind === 'log') { r.min = 0; r.max = 400; r.step = 1; }
        else { r.min = 0; r.max = c.choices.length - 1; r.step = 1; }
        const toState = (x) => c.kind === 'range' ? +x : c.kind === 'log' ? +(c.min * Math.pow(c.max / c.min, x / 400)).toPrecision(2) : c.choices[+x];
        const fromState = (v) => c.kind === 'range' ? v : c.kind === 'log' ? Math.round(400 * Math.log(v / c.min) / Math.log(c.max / c.min)) : Math.max(0, c.choices.indexOf(v));
        r.addEventListener('input', () => { state[c.key] = toState(r.value); changed(c.key); });
        wrap.appendChild(r);
        refreshers.push(() => { r.value = fromState(state[c.key]); val.textContent = c.fmt(state[c.key]); r.disabled = c.disabled ? c.disabled() : false; });
      } else if (c.kind === 'seg') {
        const s = mk('div', 'seg'); s.setAttribute('role', 'group'); s.setAttribute('aria-label', c.label);
        const btns = c.options.map(([v, t]) => { const b = mk('button', null, t); b.type = 'button'; b.addEventListener('click', () => { state[c.key] = v; changed(c.key); }); s.appendChild(b); return [v, b]; });
        wrap.appendChild(s);
        refreshers.push(() => btns.forEach(([v, b]) => b.setAttribute('aria-pressed', String(state[c.key] === v))));
      } else if (c.kind === 'checks') {
        const s = mk('div', 'checks');
        c.items.forEach(([k, t]) => {
          const l = mk('label'), i = mk('input'); i.type = 'checkbox'; i.id = 'c-' + k;
          i.addEventListener('change', () => { state[k] = i.checked; if (!state.allowRoot && !state.allowSample) { state[k] = true; } changed(k); });
          l.appendChild(i); l.appendChild(document.createTextNode(t)); s.appendChild(l);
          refreshers.push(() => { i.checked = state[k]; });
        });
        wrap.appendChild(s);
      }
      if (c.hint) wrap.appendChild(mk('div', 'hint', c.hint));
      host.appendChild(wrap);
    };
    GROUPS.forEach((g) => { const sec = mk('section', 'group'); sec.appendChild(mk('h2', null, g.title)); g.controls.forEach((c) => addCtl(sec, c)); rail.appendChild(sec); });
  }
  const refreshControls = () => refreshers.forEach((f) => f());

  /* ====================================================================== population */
  const REF = { japan2011: COST.fromCells(REF_TABLES.japan2011.cells), usArchives: COST.fromCells(REF_TABLES.usArchives.cells) };
  const refPop = { japan2011: COST.buildPop(REF.japan2011.w, REF.japan2011.ws, { wq: REF.japan2011.wq }), usArchives: COST.buildPop(REF.usArchives.w, REF.usArchives.ws, { wq: REF.usArchives.wq }) };
  const TABLES = { japan2011: REF.japan2011 };
  if (typeof SCENARIO_TABLES !== 'undefined') for (const k in SCENARIO_TABLES) TABLES[k] = COST.fromCells(SCENARIO_TABLES[k].cells);
  const scenarioTable = (name) => { const sc = CONFIG.scenarios[name], t = TABLES[sc.table] || REF.japan2011, mix = scenarioSet(name).mix; return mix > 0 ? COST.blend(t, REF.usArchives, mix / 100) : t; };
  const shareMemo = {};
  function scenarioShare(name) {
    if (shareMemo[name] == null) { const t = scenarioTable(name), j = E.indexOf(100); let a = 0; for (let i = j; i < NB; i++) for (let k = 0; k < NB; k++) { const c = i * NB + k; a += t.ws[c] - t.w[c]; } shareMemo[name] = a; }
    return shareMemo[name];
  }
  function applyScenario(name) { Object.assign(state, scenarioSet(name)); refreshControls(); refreshPopulation(); }
  let table = REF.japan2011, tableInfo = { kind: 'ref', name: 'japan2011' }, simId = 0, worker = null, simTimer = 0, pending = false;

  function startSim() {
    const id = ++simId, params = modelParams();
    if (worker) { worker.terminate(); worker = null; }
    pending = true; setBusy(true);
    const onRound = (m) => {
      if (m.id !== simId) return;
      const t = GRT.normalise(m.W, m.WS, m.WQ);
      table = t; tableInfo = { kind: 'sim', trees: m.trees, round: m.round, rounds: m.rounds, excess: m.excess, capped: m.capped };
      pending = m.round < m.rounds; if (!pending) setBusy(false);
      popCache = null; schedule();
    };
    try {
      worker = new Worker(URL.createObjectURL(new Blob([SIM_SOURCE], { type: 'text/javascript' })));
      worker.onmessage = (ev) => onRound(ev.data);
      worker.onerror = () => { worker = null; mainThreadSim(id, params, onRound); };
      worker.postMessage({ id, params, opts: CONFIG.sim });
    } catch (e) { mainThreadSim(id, params, onRound); }
  }
  function mainThreadSim(id, params, onRound) {          // fallback when workers are unavailable
    const W = new Float64Array(NB * NB), WS = new Float64Array(NB * NB), WQ = new Float64Array(NB * NB); let r = 0, trees = 0;
    const step = () => {
      if (id !== simId) return;
      const res = GRT.simulate(params, { seed: CONFIG.sim.seed + 101 * r, rounds: 1, budget: CONFIG.sim.budget });
      for (let c = 0; c < W.length; c++) { W[c] += res.W[c]; WS[c] += res.WS[c]; WQ[c] += res.WQ[c]; }
      trees += res.trees; r++;
      onRound({ id, W, WS, WQ, trees, round: r, rounds: CONFIG.sim.rounds, excess: res.excess, capped: res.capped });
      if (r < CONFIG.sim.rounds) setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }
  function refreshPopulation() {
    clearTimeout(simTimer);
    const m = matchTable();
    if (m && TABLES[m]) {
      simId++; if (worker) { worker.terminate(); worker = null; }
      table = TABLES[m]; tableInfo = { kind: 'ref', name: m }; pending = false; setBusy(false); popCache = null; schedule();
    } else { setBusy(true); simTimer = setTimeout(startSim, 140); }
  }
  const setBusy = (b) => document.getElementById('results').classList.toggle('busy', b);

  /* ====================================================================== compute */
  let popCache = null, popKey = '', raf = 0, last = null;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
  function changed(key) {
    if (key === 'base') state.params = null;
    refreshControls();
    if (POP_KEYS.has(key)) refreshPopulation(); else schedule();
  }
  function compute() {
    const key = [state.mix, state.cap, state.minReplies].join('|');
    if (!popCache || popKey !== key) {
      const t = state.mix > 0 ? COST.blend(table, REF.usArchives, state.mix / 100) : table;
      popCache = COST.buildPop(t.w, t.ws, { wq: t.wq, cap: state.cap || Infinity, descendants: state.minReplies === 'all' }); popKey = key;
    }
    return Object.assign({ pop: popCache }, analyse(popCache, true));
  }
  /* A plan trimmed to find exactly the required share, put back to keeping every candidate. */
  const whole = (pol) => { const a = pol.admit; if (!(a < 1)) return pol; const rest = (pol.cost - pol.finding) / a;
    return Object.assign({}, pol, { admit: 1, cost: pol.finding + rest, counting: pol.counting / a, wasted: pol.wasted / a, reading: pol.reading / a, recall: pol.recall / a, found: pol.found / a, posts: pol.posts / a }); };
  function analyse(pop, full) {
    const budget = state.quota / state.replies;
    const pr = { streamPost: state.streamPrice, traffic: state.traffic, count: state.countPrice, rootDays: state.rootDays, reread: state.reread, expansions: state.expansions, requestFee: state.requestFee };
    const stream = state.stream === 'none' ? { mode: 'buy' } : { mode: 'free', p: { s1: 0.01, s10: 0.1, full: 1 }[state.stream] };
    const cutBin = E.indexOf(state.cut);
    if (pop.cuts.indexOf(cutBin) < 0)           // no conversation this large in the population: say so, do not answer another question
      return { ev: null, at: null, cutBin, cut: state.cut, budget, pr, stream, show: {}, chosen: null, status: 'empty', reach: null };
    const ev = COST.evaluate(pop, pr, { recall: state.recall, budget, cutSel: cutBin, allowRoot: state.allowRoot, allowSample: state.allowSample, stream });
    const at = ev.byCut[ev.selIdx];
    // the plan shown for each strategy: the cheapest tested one that finds the required share; failing that, the most it finds in the quota.
    // Root search is shown at half the cutoff when reaching the required share would cost more than twice the conversations themselves.
    const show = {};
    for (const f of (full ? FAMS : [])) {
      const s = at.families[f]; let pol = null;
      if (f === 'root') {
        if (state.allowRoot) pol = s.atFloor && s.atFloor.cost <= 2 * at.tierPosts ? s.atFloor : COST.rootPolicy(pop, pr, cutBin, Math.max(1, Math.floor(E[cutBin] / 2)), true);
      } else pol = s.atFloor || s.inBudget || null;
      if (pol && pol === s.atFloor && whole(pol).cost <= budget) pol = whole(pol);      // no need to drop candidates when the whole plan fits
      if (pol) show[f] = Object.assign({ cover: COST.coverage(pop, pol) }, pol);
    }
    // status: ok = the required share fits the quota; short = it can be found, but not within the quota;
    //         ceiling = no allowed plan finds the required share at any cost; none = nothing is allowed or affordable
    let chosen = null, status = 'ok';
    if (at.atFloor && at.atFloor.cost <= budget) chosen = whole(at.atFloor).cost <= budget ? whole(at.atFloor) : at.atFloor;
    else if (at.inBudget) { chosen = at.inBudget; status = at.atFloor ? 'short' : 'ceiling'; }
    else { chosen = at.atFloor; status = chosen ? 'over' : 'none'; }
    if (chosen) chosen = Object.assign({ cover: COST.coverage(pop, chosen) }, chosen);
    const reach = ev.byCut.find((c) => c.atFloor && c.atFloor.cost <= budget);
    return { ev, at, cutBin, cut: E[cutBin], budget, pr, stream, show, chosen, status, reach };
  }

  /* ====================================================================== words */
  const pShow = (p) => (100 * p >= 10 ? (100 * p).toFixed(0) : (100 * p).toPrecision(2)) + '%';
  function famName(pol) {
    const free = state.stream !== 'none';
    if (pol.family === 'root') return 'Root search';
    const s = free ? (pol.p >= 1 ? 'the full stream' : 'the free ' + pShow(pol.p) + ' stream') : 'a ' + pShow(pol.p) + ' reply sample';
    return pol.family === 'sample' ? s.charAt(0).toUpperCase() + s.slice(1) : 'Root search plus ' + s;
  }
  function recipe(pol, cut) {
    const parts = [], unit = state.minReplies === 'all' ? 'replies below them' : 'direct replies';
    if (pol.T) parts.push('Search for original posts (roots) with at least ' + int(pol.T) + ' ' + unit + '.');
    if (pol.full) { parts.push('Keep the full stream. It already holds every reply, so sizes are known. Download only the root of each conversation with ' + int(cut) + '+ posts.'); }
    else {
      if (pol.p) parts.push((state.stream !== 'none' ? 'Take the free ' + pShow(pol.p) + ' stream of replies.' : 'Buy a random ' + pShow(pol.p) + ' of replies.')
        + ' Flag a conversation once ' + (pol.h === 1 ? 'one of its replies appears' : pol.h + ' of its replies appear') + ' in the sample.');
      if (pol.admit < 0.995) parts.push('Keep a random ' + pct(pol.admit) + ' of the flagged conversations.');
      parts.push(pol.count ? 'Look up the size of each ' + (pol.admit < 0.995 ? 'one kept' : 'flagged conversation') + ' (one count request) and download those with ' + int(cut) + '+ posts.' : 'Download every ' + (pol.admit < 0.995 ? 'one kept' : 'flagged conversation') + ' without checking its size first.');
    }
    if (state.cap) parts.push('Download only the first ' + int(state.cap) + ' posts of each.');
    return parts.join(' ');
  }

  /* ====================================================================== svg helpers */
  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent, text) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function frame(id, height, label) {
    const host = document.getElementById(id);
    host.querySelectorAll('svg').forEach((s) => s.remove());
    const w = Math.max(300, Math.floor(host.clientWidth));
    const svg = el('svg', { viewBox: '0 0 ' + w + ' ' + height, role: 'img', 'aria-label': label });
    host.insertBefore(svg, host.firstChild);
    let tip = host.querySelector('.tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; host.appendChild(tip); }
    const showTip = (x, y, html) => {
      tip.innerHTML = html; tip.hidden = false;
      const tw = tip.offsetWidth, left = Math.min(Math.max(4, x + 14), host.clientWidth - tw - 4);
      tip.style.left = (x + 14 + tw > host.clientWidth ? Math.max(4, x - tw - 14) : left) + 'px'; tip.style.top = Math.max(0, y - 10) + 'px';
    };
    return { host, svg, w, h: height, showTip, hideTip: () => { tip.hidden = true; } };
  }
  const lin = (d0, d1, r0, r1) => (v) => r0 + (v - d0) / (d1 - d0) * (r1 - r0);
  const logS = (d0, d1, r0, r1) => { const a = Math.log(d0), b = Math.log(d1); const f = (v) => r0 + (Math.log(v) - a) / (b - a) * (r1 - r0); f.inv = (px) => Math.exp(a + (px - r0) / (r1 - r0) * (b - a)); return f; };
  function logTicks(d0, d1) {
    const out = [], span = Math.log10(d1 / d0), mult = span < 2.6 ? [1, 2, 5] : [1];
    for (let e = Math.floor(Math.log10(d0)); e <= Math.ceil(Math.log10(d1)); e++) for (const m of mult) { const v = m * Math.pow(10, e); if (v >= d0 * 0.999 && v <= d1 * 1.001) out.push(v); }
    return out;
  }
  function decadeTicks(d0, d1) { const out = [d0]; for (let e = Math.ceil(Math.log10(d0) + 0.3); Math.pow(10, e) <= d1 * 1.001; e++) out.push(Math.pow(10, e)); return out; }
  const path = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const legend = (id, items) => { document.getElementById(id).innerHTML = items.map(([cls, color, text, extra]) => '<span><i class="' + cls + '" style="background:' + color + ';' + (extra || '') + '"></i>' + text + '</span>').join(''); };
  const row = (color, name, val) => '<div class="row"><span>' + (color ? '<i style="background:' + color + '"></i>' : '') + name + '</span><span class="num">' + val + '</span></div>';

  /* ====================================================================== charts */
  /* The chosen plan as a flow: two ways of finding, one count, one fetch, with monthly numbers. */
  function drawLogic(d) {
    const c = d.chosen, host = document.getElementById('ch-logic');
    if (!c) { host.querySelectorAll('svg').forEach((x) => x.remove()); return; }
    const R = state.replies, free = state.stream !== 'none', col = FAM[c.family].color;
    const rootPart = c.T ? COST.rootPolicy(d.pop, d.pr, d.cutBin, c.T, true) : null;
    const rootCand = rootPart ? rootPart.cand : 0, sampleCand = Math.max(0, c.cand - rootCand);
    const streamCost = c.p && !free ? d.pr.streamPost * d.pr.traffic * c.p : 0, rootCost = Math.max(0, c.finding - streamCost);
    const unit = state.minReplies === 'all' ? 'replies below' : 'direct replies';
    const adm = c.admit == null ? 1 : c.admit, part = adm < 0.995, kept = adm * c.cand, small = Math.max(0, kept - c.found);
    const boxes = {
      root: c.T ? { on: true, color: 'var(--root)', title: 'Root search', lines: ['roots with ' + int(c.T) + '+ ' + unit, big(rootCand * R) + ' flagged a month', 'costs ' + big(rootCost * R) + ' units'] }
                : { on: false, title: 'Root search', lines: ['not used in this plan'] },
      sample: c.full ? { on: true, color: 'var(--sample)', title: 'Full reply stream', lines: ['already holds every reply', big(c.cand * R) + ' reach ' + int(d.cut) + ' posts', 'outside the quota'] }
            : c.p ? { on: true, color: 'var(--sample)', title: free ? 'Free ' + pShow(c.p) + ' reply stream' : pShow(c.p) + ' reply sample',
                      lines: ['flagged at the ' + ord(c.h) + ' sampled reply', big(sampleCand * R) + ' flagged a month', free ? 'outside the quota' : 'costs ' + big(streamCost * R) + ' units'] }
                  : { on: false, title: 'Reply sample', lines: ['not used in this plan'] },
      count: c.full ? { on: true, title: 'No size check needed', lines: ['sizes are known from the stream', 'nothing is skipped', 'costs nothing'] }
           : c.count ? { on: true, title: part ? 'Keep ' + pct(adm) + ', check each size' : 'Check each one\u2019s size', lines: [big(kept * R) + ' count requests at ' + state.countPrice + (state.countPrice === 1 ? ' unit' : ' units'), big(small * R) + ' under ' + int(d.cut) + ' posts, skipped', 'costs ' + big(c.counting * R) + ' units'] }
                     : { on: true, title: part ? 'Keep ' + pct(adm) + ', no size check' : 'No size check', lines: [big(kept * R) + ' downloaded unchecked', big(small * R) + ' turn out under ' + int(d.cut) + ' posts', 'costs nothing'] },
      fetch: c.full ? { on: true, title: 'Download the roots', lines: [big(c.found * R) + ' roots, one post each', 'replies are already in hand', 'costs ' + big(c.reading * R) + ' units'] }
           : { on: true, title: 'Download the conversation', lines: [big(c.found * R) + ' with ' + int(d.cut) + '+ posts', state.cap ? 'first ' + int(state.cap) + ' posts of each' : c.wasted > 0 ? big(c.wasted * R) + ' units on ones too small' : 'each post read once', 'costs ' + big((c.reading + c.wasted) * R) + ' units'] },
      done: { on: true, color: col, fill: true, title: 'Collected', lines: [big(c.found * R) + ' conversations a month', pct(c.recall) + ' of the ' + big(d.at.tierW * R) + ' of ' + int(d.cut) + '+ posts', big(c.cost * R) + ' units, ' + pct(c.cost / d.budget) + ' of quota'] },
    };
    const wide = host.clientWidth >= 760, BH = 90, uid = 'lg' + (drawLogic.n = (drawLogic.n || 0) + 1);
    const f = frame('ch-logic', wide ? 2 * BH + 16 + 20 : 5 * BH + 4 * 26 + 12, 'The chosen plan as a flow: finding, counting, fetching and what is collected');
    const defs = el('defs', {}, f.svg), mk = el('marker', { id: uid, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M0 0L10 5L0 10z', fill: 'var(--ink-3)' }, mk);
    const box = (b, x, y, w) => {
      const g = el('g', { opacity: b.on ? 1 : 0.5 }, f.svg);
      el('rect', { x, y, width: w, height: BH, rx: 9, fill: b.fill ? b.color : 'var(--surface)', 'fill-opacity': b.fill ? 0.12 : 1, stroke: b.on ? (b.color || 'var(--line-2)') : 'var(--line-2)', 'stroke-width': b.color && b.on ? 1.75 : 1.25, 'stroke-dasharray': b.on ? null : '4 4' }, g);
      el('text', { x: x + 14, y: y + 24, class: 'strong', style: 'font-size:13px' }, g, b.title);
      b.lines.forEach((t, i) => el('text', { x: x + 14, y: y + 42 + 16 * i, style: i === b.lines.length - 1 && b.lines.length === 3 ? 'fill:var(--ink)' : '' }, g, t));
    };
    const arrow = (dd) => el('path', { d: dd, fill: 'none', stroke: 'var(--ink-3)', 'stroke-width': 1.25, 'marker-end': 'url(#' + uid + ')' }, f.svg);
    if (wide) {
      const gap = 38, x0 = 2, w = f.w - 4, wf = Math.round((w - 3 * gap) * 0.29), wo = (w - 3 * gap - wf) / 3;
      const yTop = 10, yMid = yTop + (2 * BH + 16 - BH) / 2, xs = [x0, x0 + wf + gap, x0 + wf + gap + wo + gap, x0 + wf + gap + 2 * (wo + gap)];
      const cy = yMid + BH / 2, mx = xs[1] - gap / 2;
      if (boxes.root.on) arrow('M' + (xs[0] + wf) + ' ' + (yTop + BH / 2) + 'H' + mx + 'V' + (cy - (boxes.sample.on ? 10 : 0)) + 'H' + xs[1]);
      if (boxes.sample.on) arrow('M' + (xs[0] + wf) + ' ' + (yTop + BH + 16 + BH / 2) + 'H' + mx + 'V' + (cy + (boxes.root.on ? 10 : 0)) + 'H' + xs[1]);
      arrow('M' + (xs[1] + wo) + ' ' + cy + 'H' + xs[2]); arrow('M' + (xs[2] + wo) + ' ' + cy + 'H' + xs[3]);
      box(boxes.root, xs[0], yTop, wf); box(boxes.sample, xs[0], yTop + BH + 16, wf);
      box(boxes.count, xs[1], yMid, wo); box(boxes.fetch, xs[2], yMid, wo); box(boxes.done, xs[3], yMid, wo);
      el('text', { x: xs[0] + 2, y: yTop + 2 * BH + 16 + 16, class: 'tick' }, f.svg, 'FIND');
      el('text', { x: xs[1] + 2, y: yMid + BH + 16, class: 'tick' }, f.svg, 'CHECK SIZE'); el('text', { x: xs[2] + 2, y: yMid + BH + 16, class: 'tick' }, f.svg, 'DOWNLOAD'); el('text', { x: xs[3] + 2, y: yMid + BH + 16, class: 'tick' }, f.svg, 'RESULT');
    } else {
      const w = f.w - 4, x = 2, order = ['root', 'sample', 'count', 'fetch', 'done'];
      order.forEach((k, i) => { const y = 4 + i * (BH + 26); box(boxes[k], x, y, w); if (i === 0) el('text', { x: x + w / 2, y: y + BH + 18, 'text-anchor': 'middle', class: 'strong' }, f.svg, 'and'); else if (i < order.length - 1) arrow('M' + (x + w / 2) + ' ' + (y + BH + 3) + 'V' + (y + BH + 23)); });
    }
    const q = c.cover ? c.cover.foundQuiet : null;
    document.getElementById('sub-logic').textContent = 'The headline plan, step by step, in numbers a month. Dashed boxes are not used by this plan. One unit is the charge for one post.'
      + (q != null ? ' It misses ' + big(Math.max(0, d.at.tierW - c.found) * R) + ' conversations of ' + int(d.cut) + '+ posts a month, and finds ' + pct(q) + ' of the quiet-root ones.' : '');
  }

  function drawFrontier(d) {
    const R = state.replies, f = frame('ch-frontier', 330, 'Share of target conversations found against units spent each month, by way of finding');
    const m = { l: 46, r: 18, t: 22, b: 42 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t;
    const fr = d.ev.frontier; let lo = Infinity, hi = 0;
    for (const k of FAMS) if (fr[k].length) { lo = Math.min(lo, fr[k][0][0]); hi = Math.max(hi, fr[k][fr[k].length - 1][0]); }
    if (!isFinite(lo)) return;
    hi = Math.min(hi, 2.2); const quota = state.quota;
    const dx0 = Math.min(lo * R / 1.8, quota / 1.5), dx1 = Math.max(hi * R * 1.25, quota * 1.6);
    const X = logS(dx0, dx1, x0, x1), Y = lin(0, 1, y0, y1);
    if (quota < dx1) el('rect', { x: X(quota), y: y1, width: x1 - X(quota), height: y0 - y1, fill: 'var(--over)', 'fill-opacity': 0.05 }, f.svg);
    for (const v of [0, 0.25, 0.5, 0.75, 1]) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, Math.round(100 * v) + '%'); }
    for (const v of logTicks(dx0, dx1)) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': 'middle', class: 'tick' }, f.svg, big(v)); }
    el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
    el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Units spent a month (log scale)');
    // floor and quota
    el('line', { x1: x0, x2: x1, y1: Y(state.recall), y2: Y(state.recall), stroke: 'var(--ink-3)', 'stroke-dasharray': '3 4' }, f.svg);
    el('text', { x: x0 + 6, y: Y(state.recall) - 6 }, f.svg, 'must find ' + Math.round(100 * state.recall) + '%');
    el('line', { x1: X(quota), x2: X(quota), y1: y1 - 6, y2: y0, stroke: 'var(--ink)', 'stroke-width': 1.25 }, f.svg);
    const qRight = X(quota) < x1 - 90;
    el('text', { x: X(quota) + (qRight ? 6 : -6), y: y1 - 8, 'text-anchor': qRight ? 'start' : 'end', class: 'strong' }, f.svg, 'Quota ' + big(quota));
    if (R > dx0 && R < dx1 && Math.abs(X(R) - X(quota)) > 70) { el('line', { x1: X(R), x2: X(R), y1: y1, y2: y0, stroke: 'var(--line-2)', 'stroke-dasharray': '2 3' }, f.svg); el('text', { x: X(R) - 5, y: y0 - 8, 'text-anchor': 'end' }, f.svg, 'reading every reply once'); }
    // lines
    for (const k of FAMS) {
      if (!fr[k].length) continue;
      const pts = fr[k].filter((p) => p[0] * R >= dx0 && p[0] * R <= dx1).map((p) => [X(p[0] * R), Y(p[1])]);
      if (pts.length && fr[k][fr[k].length - 1][0] * R < dx1) pts.push([x1, pts[pts.length - 1][1]]);
      if (pts.length > 1) el('path', { d: path(pts), fill: 'none', stroke: FAM[k].color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, f.svg);
    }
    if (d.chosen) {
      const cx = X(Math.max(dx0, Math.min(dx1, d.chosen.cost * R))), cy = Y(d.chosen.recall);
      el('circle', { cx, cy, r: 6.5, fill: 'var(--surface)', stroke: FAM[d.chosen.family].color, 'stroke-width': 2.5 }, f.svg);
      el('circle', { cx, cy, r: 2.5, fill: FAM[d.chosen.family].color }, f.svg);
    }
    // hover
    const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', 'stroke-width': 1, visibility: 'hidden' }, f.svg);
    const ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
    ov.addEventListener('pointermove', (ev) => {
      const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width, cost = X.inv(px) / R;
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      let html = '<b>' + big(cost * R) + ' units a month</b> · ' + pct(cost * R / quota) + ' of quota';
      for (const k of FAMS) { let best = null; for (const p of fr[k]) { if (p[0] <= cost) best = p; else break; } html += row(FAM[k].color, FAM[k].name, best ? 'finds ' + pct(best[1]) : fr[k].length ? 'nothing yet' : 'not allowed'); }
      f.showTip(px * b.width / f.w, ev.clientY - b.top, html);
    });
    ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    legend('leg-frontier', FAMS.filter((k) => fr[k].length).map((k) => ['', FAM[k].color, k === 'sample' && state.stream !== 'none' ? 'Free stream' : k === 'both' && state.stream !== 'none' ? 'Root search + free stream' : FAM[k].name]).concat([['dot', 'var(--ink-2)', 'the plan described above']]));
  }

  function drawBars(d) {
    const R = state.replies, fams = FAMS.filter((k) => d.show[k]), rowH = 58;
    const f = frame('ch-bars', fams.length * rowH + 40, 'Units spent each month by way of finding, split into finding, size checks and downloading');
    const m = { l: 8, r: 64, t: 6 }, x0 = m.l, x1 = f.w - m.r;
    const maxC = Math.max.apply(null, fams.map((k) => d.show[k].cost * R));
    const X = lin(0, maxC * 1.02, x0, x1), y0 = m.t + fams.length * rowH;
    const quota = state.quota, qIn = quota <= maxC * 1.02;
    fams.forEach((k, i) => {
      const p = d.show[k], y = m.t + i * rowH, col = FAM[k].color;
      el('text', { x: x0, y: y + 14, class: 'strong' }, f.svg, famName(p));
      const lab = el('text', { x: x1 + 6, y: y + 38, class: 'tick' }, f.svg, big(p.cost * R));
      lab.setAttribute('style', 'font-size:12px;fill:var(--ink)');
      el('text', { x: x1, y: y + 14, 'text-anchor': 'end' }, f.svg, 'finds ' + pct(p.recall));
      const segs = [['reading', 1], ['finding', 0.55], ['counting', 0.28], ['wasted', 0.12]]; let cx = x0;
      const g = el('g', {}, f.svg);
      for (const [name, op] of segs) {
        const wpx = X(p[name] * R) - X(0); if (wpx <= 0) continue;
        const wd = Math.max(1.5, wpx - (wpx > 4 ? 2 : 0));
        el('rect', { x: cx, y: y + 22, width: wd, height: 22, rx: 3, fill: col, 'fill-opacity': op, stroke: name === 'wasted' ? col : null, 'stroke-dasharray': name === 'wasted' ? '3 2' : null }, g);
        cx += wpx;
      }
      const hit = el('rect', { x: x0, y: y + 4, width: x1 - x0, height: rowH - 8, fill: 'transparent' }, f.svg);
      hit.addEventListener('pointermove', (ev) => {
        const b = f.svg.getBoundingClientRect();
        f.showTip(ev.clientX - b.left, ev.clientY - b.top, '<b>' + famName(p) + '</b>' + row('', 'Downloading the conversations', big(p.reading * R)) + row('', 'Finding them', big(p.finding * R))
          + row('', 'Size checks', big(p.counting * R)) + (p.wasted > 0 ? row('', 'Read, then discarded', big(p.wasted * R)) : '') + row('', 'Total', big(p.cost * R) + ' · ' + pct(p.cost * R / quota) + ' of quota'));
      });
      hit.addEventListener('pointerleave', f.hideTip);
    });
    el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
    const step = niceStep(maxC * 1.02 / 4);
    for (let v = 0; v <= maxC * 1.02; v += step) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': v === 0 ? 'start' : 'middle', class: 'tick' }, f.svg, v === 0 ? '0' : big(v)); }
    if (qIn) { el('line', { x1: X(quota), x2: X(quota), y1: m.t, y2: y0, stroke: 'var(--ink)', 'stroke-width': 1.25 }, f.svg); el('text', { x: X(quota) - 5, y: y0 - 4, 'text-anchor': 'end', class: 'strong' }, f.svg, 'Quota'); }
    el('text', { x: x1, y: f.h - 4, 'text-anchor': 'end' }, f.svg, 'units a month' + (qIn ? '' : ' · quota ' + big(quota) + ' is off the scale'));
    legend('leg-bars', [['box', 'var(--ink-2)', 'Downloading the conversations'], ['box', 'var(--ink-2)', 'Finding them', 'opacity:.55'], ['box', 'var(--ink-2)', 'Size checks', 'opacity:.28'], ['box', 'var(--ink-2)', 'Downloaded, then discarded', 'opacity:.12']]);
  }
  function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p; return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p; }

  function drawReach(d) {
    const R = state.replies, pts = d.ev.byCut.filter((c) => c.atFloor).map((c) => [c.size, c.atFloor.cost * R, c.atFloor]);
    const f = frame('ch-reach', 300, 'Units a month needed to collect conversations above each size');
    if (pts.length < 2) return;
    const m = { l: 46, r: 16, t: 20, b: 42 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t, quota = state.quota;
    const ys = pts.map((p) => p[1]), X = logS(pts[0][0], pts[pts.length - 1][0], x0, x1);
    const Y = logS(Math.min(Math.min.apply(null, ys), quota) / 1.6, Math.max(Math.max.apply(null, ys), quota) * 1.6, y0, y1);
    el('rect', { x: x0, y: y1, width: x1 - x0, height: Math.max(0, Y(quota) - y1), fill: 'var(--over)', 'fill-opacity': 0.05 }, f.svg);
    for (const v of logTicks(Y.inv(y0), Y.inv(y1))) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, big(v)); }
    for (const v of logTicks(pts[0][0], pts[pts.length - 1][0])) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': 'middle', class: 'tick' }, f.svg, int(v)); }
    el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
    el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Smallest conversation collected, in posts');
    el('line', { x1: x0, x2: x1, y1: Y(quota), y2: Y(quota), stroke: 'var(--ink)', 'stroke-width': 1.25 }, f.svg);
    el('text', { x: x1 - 4, y: Y(quota) - 6, 'text-anchor': 'end', class: 'strong' }, f.svg, 'Quota ' + big(quota));
    el('path', { d: path(pts.map((p) => [X(p[0]), Y(p[1])])), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2 }, f.svg);
    const sel = pts.find((p) => p[0] === d.cut);
    if (sel) { el('circle', { cx: X(sel[0]), cy: Y(sel[1]), r: 5.5, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 2.5 }, f.svg); el('text', { x: X(sel[0]) + 9, y: Y(sel[1]) - 8, class: 'strong' }, f.svg, int(sel[0]) + '+'); }
    const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', visibility: 'hidden' }, f.svg);
    const ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
    ov.addEventListener('pointermove', (ev) => {
      const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width, s = X.inv(px);
      let best = pts[0]; for (const p of pts) if (Math.abs(Math.log(p[0] / s)) < Math.abs(Math.log(best[0] / s))) best = p;
      cross.setAttribute('x1', X(best[0])); cross.setAttribute('x2', X(best[0])); cross.setAttribute('visibility', 'visible');
      f.showTip(X(best[0]) * b.width / f.w, ev.clientY - b.top, '<b>' + int(best[0]) + ' posts or more</b>' + row('', 'Charge', big(best[1]) + ' units a month') + row('', 'Share of quota', pct(best[1] / quota)) + row('', 'Cheapest way', FAM[best[2].family].name));
    });
    ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
  }

  function drawCover(d) {
    const fams = FAMS.filter((k) => d.show[k]), n = fams.length;
    const f = frame('ch-cover', f0h(), 'Probability that a conversation is collected, by its size and shape, for each way of finding');
    function f0h() { const w = document.getElementById('ch-cover').clientWidth; return w < 620 ? n * 200 : 246; }
    const stacked = f.w < 620, gap = 40, m = { l: 40, r: 14, t: 40, b: 36 };
    const pw = stacked ? f.w - m.l - m.r : (f.w - m.l - m.r - gap * (n - 1)) / n, ph = stacked ? 200 - m.t - m.b : f.h - m.t - m.b;
    let maxBin = d.cutBin; for (let i = d.cutBin; i < NB; i++) if (d.pop.Wi[i] > 0) maxBin = i;
    const sMax = Math.max(E[maxBin], d.cut * 10);
    fams.forEach((k, idx) => {
      const p = d.show[k], px0 = m.l + (stacked ? 0 : idx * (pw + gap)), py1 = (stacked ? idx * 200 : 0) + m.t, py0 = py1 + ph;
      const X = logS(d.cut, sMax, px0, px0 + pw), Y = lin(0, 1, py0, py1);
      el('text', { x: px0, y: py1 - 20, class: 'strong', style: 'fill:' + FAM[k].color }, f.svg, famName(p));
      el('text', { x: px0 + pw, y: py1 - 20, 'text-anchor': 'end' }, f.svg, 'finds ' + pct(p.recall));
      for (const v of [0, 0.5, 1]) { el('line', { x1: px0, x2: px0 + pw, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); if (idx === 0 || stacked) el('text', { x: px0 - 7, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, Math.round(100 * v) + '%'); }
      { const tk = decadeTicks(d.cut, sMax); tk.forEach((v, ti) => el('text', { x: X(v), y: py0 + 16, 'text-anchor': ti === 0 ? 'start' : ti === tk.length - 1 && X(v) > px0 + pw - 16 ? 'end' : 'middle', class: 'tick' }, f.svg, int(v))); }
      el('line', { x1: px0, x2: px0 + pw, y1: py0, y2: py0, stroke: 'var(--line-2)' }, f.svg);
      for (const [cls, col, wd] of [['driven', 'var(--ink-2)', 2], ['quiet', 'var(--quiet)', 2.5]]) {
        const pts = [];
        for (let i = d.cutBin; i <= maxBin; i++) { const v = p.cover.incl[cls][i]; if (v == null) continue; const sz = d.pop.Wi[i] ? d.pop.Si[i] / d.pop.Wi[i] : E[i]; pts.push([X(Math.min(sMax, Math.max(d.cut, sz))), Y(v)]); }
        if (pts.length > 1) el('path', { d: path(pts), fill: 'none', stroke: col, 'stroke-width': wd, 'stroke-linejoin': 'round' }, f.svg);
        else if (pts.length === 1) el('circle', { cx: pts[0][0], cy: pts[0][1], r: 3, fill: col }, f.svg);
      }
      const hit = el('rect', { x: px0, y: py1, width: pw, height: ph, fill: 'transparent' }, f.svg);
      hit.addEventListener('pointermove', (ev) => {
        const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width, s = X.inv(px);
        let i = d.cutBin; for (let j = d.cutBin; j <= maxBin; j++) if (E[j] <= s) i = j;
        const fmtv = (v) => v == null ? 'none this size' : pct(v);
        f.showTip(ev.clientX - b.left, ev.clientY - b.top, '<b>About ' + int(E[i]) + ' posts</b>' + row('var(--ink-2)', 'Root-driven collected', fmtv(p.cover.incl.driven[i])) + row('var(--quiet)', 'Quiet-root collected', fmtv(p.cover.incl.quiet[i])));
      });
      hit.addEventListener('pointerleave', f.hideTip);
    });
    el('text', { x: m.l + (f.w - m.l - m.r) / 2, y: f.h - 2, 'text-anchor': 'middle' }, f.svg, 'Conversation size, in posts (log scale)');
    legend('leg-cover', [['', 'var(--ink-2)', 'Root-driven: at least half of replies answer the root'], ['', 'var(--quiet)', 'Quiet-root: fewer than half do']]);
  }

  function drawShape(d) {
    const fams = FAMS.filter((k) => d.show[k]), rowH = 34;
    const f = frame('ch-shape', fams.length * rowH + 44, 'Share of root-driven and quiet-root conversations found by each way of finding');
    const wide = f.w >= 620, m = { l: wide ? 220 : 8, r: wide ? 270 : 8, t: 20 }, x0 = m.l, x1 = f.w - m.r, X = lin(0, 1, x0, x1), yb = m.t + fams.length * rowH;
    el('text', { x: x0, y: 10 }, f.svg, 'Share of each shape that is found');
    legendDots(f, x1, 10);
    for (const v of [0, 0.25, 0.5, 0.75, 1]) { el('line', { x1: X(v), x2: X(v), y1: m.t, y2: yb, stroke: 'var(--grid)' }, f.svg); el('text', { x: X(v), y: yb + 16, 'text-anchor': 'middle', class: 'tick' }, f.svg, Math.round(100 * v) + '%'); }
    fams.forEach((k, i) => {
      const p = d.show[k], y = m.t + i * rowH + rowH / 2, c = p.cover, q = c.foundQuiet, dr = c.foundDriven;
      if (wide) el('text', { x: x0 - 12, y: y + 4, 'text-anchor': 'end', class: 'strong' }, f.svg, famName(p));
      else el('text', { x: x0, y: y - 9, class: 'strong', style: 'font-size:10.5px' }, f.svg, famName(p));
      if (q != null && dr != null) el('line', { x1: X(q), x2: X(dr), y1: y, y2: y, stroke: 'var(--line-2)', 'stroke-width': 3, 'stroke-linecap': 'round' }, f.svg);
      if (dr != null) el('circle', { cx: X(dr), cy: y, r: 6, fill: 'var(--surface)', stroke: 'var(--ink-2)', 'stroke-width': 2.5 }, f.svg);
      if (q != null) el('circle', { cx: X(q), cy: y, r: 6, fill: 'var(--quiet)', stroke: 'var(--surface)', 'stroke-width': 2 }, f.svg);
      if (wide && c.trueQuietShare != null) {
        const t = el('text', { x: x1 + 16, y: y + 4 }, f.svg);
        el('tspan', {}, t, 'quiet-root share: true '); el('tspan', { class: 'strong', style: 'fill:var(--ink)' }, t, pct(c.trueQuietShare)); el('tspan', {}, t, ', collected '); el('tspan', { class: 'strong', style: 'fill:var(--ink)' }, t, pct(c.collectedQuietShare));
      }
      const hit = el('rect', { x: 0, y: y - rowH / 2, width: f.w, height: rowH, fill: 'transparent' }, f.svg);
      hit.addEventListener('pointermove', (ev) => {
        const b = f.svg.getBoundingClientRect();
        f.showTip(ev.clientX - b.left, ev.clientY - b.top, '<b>' + famName(p) + '</b>' + row('var(--ink-2)', 'Root-driven found', pct(dr)) + row('var(--quiet)', 'Quiet-root found', pct(q))
          + row('', 'Quiet-root share, truth', pct(c.trueQuietShare)) + row('', 'Quiet-root share, collected', pct(c.collectedQuietShare)));
      });
      hit.addEventListener('pointerleave', f.hideTip);
    });
  }

  function legendDots(f, x1, y) {
    el('circle', { cx: x1 - 150, cy: y - 4, r: 4.5, fill: 'var(--quiet)' }, f.svg); el('text', { x: x1 - 141, y: y }, f.svg, 'quiet-root');
    el('circle', { cx: x1 - 70, cy: y - 4, r: 4, fill: 'var(--surface)', stroke: 'var(--ink-2)', 'stroke-width': 2 }, f.svg); el('text', { x: x1 - 61, y: y }, f.svg, 'root-driven');
  }

  function drawPop(d) {
    const f = frame('ch-pop', 300, 'Share of replies in conversations of at least each size: current assumptions against the two reference data sets');
    const m = { l: 52, r: 120, t: 14, b: 42 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t;
    const X = logS(2, 1e5, x0, x1), Y = logS(1e-5, 1, y0, y1);
    for (const v of [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1]) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, v >= 0.01 ? Math.round(100 * v) + '%' : (100 * v) + '%'); }
    for (const v of [2, 10, 100, 1000, 10000, 100000]) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': 'middle', class: 'tick' }, f.svg, int(v)); }
    el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
    el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Conversations of at least this many posts (log scale)');
    const curve = (pop) => { const c = COST.shareCurve(pop), pts = []; for (let i = 1; i < NB && E[i] <= 1e5; i++) if (c[i] > 1e-5) pts.push([X(E[i]), Y(Math.min(1, c[i])), E[i], c[i]]); return pts; };
    const series = [['US archives, 2018 to 2019', curve(refPop.usArchives), 'var(--ref)', 1.5, '5 4'], ['Japan 2011', curve(refPop.japan2011), 'var(--ref)', 1.5, null], ['Your assumptions', curve(d.pop), 'var(--ink)', 2.5, null]];
    const same = state.base === 'japan2011' && knobsNeutral() && state.mix === 0;
    let lastY = -99;
    series.forEach(([name, pts, col, wd, dash], si) => {
      if (!pts.length) return;
      el('path', { d: path(pts), fill: 'none', stroke: col, 'stroke-width': wd, 'stroke-dasharray': dash, 'stroke-linejoin': 'round' }, f.svg);
      if (si === 1 && same) return;
      const end = pts[pts.length - 1]; let ly = end[1] + 4; if (Math.abs(ly - lastY) < 13) ly = lastY + 13; lastY = ly;
      el('text', { x: Math.min(end[0] + 7, x1 + 6), y: ly, class: si === 2 ? 'strong' : '' }, f.svg, si === 2 && same ? 'Your assumptions = Japan 2011' : name);
    });
    const mine = series[2][1], at = mine.find((p) => p[2] === d.cut);
    if (at) { el('circle', { cx: at[0], cy: at[1], r: 5.5, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 2.5 }, f.svg); el('text', { x: at[0] + 9, y: at[1] - 8, class: 'strong' }, f.svg, pct(at[3]) + ' in ' + int(d.cut) + '+'); }
    const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', visibility: 'hidden' }, f.svg);
    const ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
    ov.addEventListener('pointermove', (ev) => {
      const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width, s = X.inv(px);
      let i = 1; for (let j = 1; j < NB; j++) if (E[j] <= s) i = j;
      cross.setAttribute('x1', X(E[i])); cross.setAttribute('x2', X(E[i])); cross.setAttribute('visibility', 'visible');
      const val = (pop) => pct(COST.shareCurve(pop)[i]);
      f.showTip(X(E[i]) * b.width / f.w, ev.clientY - b.top, '<b>Replies in conversations of ' + int(E[i]) + '+ posts</b>' + row('var(--ink)', 'Your assumptions', val(d.pop)) + row('var(--ref)', 'Japan 2011', val(refPop.japan2011)) + row('var(--ref)', 'US archives', val(refPop.usArchives)));
    });
    ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    legend('leg-pop', []);
  }

  /* ====================================================================== the model, pictured */
  function seeded(seed) {                      // small seeded generator for the specimen conversations
    let a = (seed >>> 0) || 1, spare = 0, has = false;
    const u = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296; };
    const n = () => { if (has) { has = false; return spare; } let x, y, r; do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r >= 1 || r === 0); const f = Math.sqrt(-2 * Math.log(r) / r); spare = y * f; has = true; return x * f; };
    return { u, n };
  }
  const answerParts = (P, K, theta, direct) => {
    const x = Math.log(K), al = 1 + (P.alpha0 - 1) * Math.exp(-(direct ? P.b1 : P.b2) * x);
    const q = direct ? logistic(P.c0 - P.c1 * x + P.s1 * theta) : logistic(P.mu - P.gam * x + P.sig * theta);
    const phi = logistic((direct ? P.g0 : P.f0) + P.f1 * x) / (1 + GRT.zeta(al));
    return { q, phi, al, any: q + (1 - q) * phi };
  };
  /* One conversation with its structure kept. Each direct reply has its own random stream, so the same
     draw changes smoothly as parameters move. Stops at maxNodes posts. */
  function specimen(P, K, theta, seed, maxNodes) {
    const nodes = [{ parent: -1, depth: 0, kids: [] }]; let cut = false;
    const d1 = answerParts(P, K, theta, true), d2 = answerParts(P, K, theta, false), base = P.mu - P.gam * Math.log(K) + P.sig * theta;
    const add = (parent) => { nodes.push({ parent, depth: nodes[parent].depth + 1, kids: [] }); nodes[parent].kids.push(nodes.length - 1); return nodes.length - 1; };
    for (let i = 0; i < K && !cut; i++) {
      const g = seeded(seed * 7919 + i * 104729 + 13), pending = [[0, true]];
      while (pending.length && !cut) {
        const [par, isRoot] = pending.shift();
        const z = base + P.tau * g.n(), logU = z > 35 ? -Math.exp(-z) : -Math.log1p(Math.exp(-z));
        const cont = g.u() < (isRoot ? d1.q : Math.exp(logU));
        let len = 1; if (cont) len = 2 + Math.floor(Math.log(g.u()) / logU);
        let cur = par; for (let j = 0; j < len; j++) { if (nodes.length >= maxNodes) { cut = true; break; } cur = add(cur); }
        const end1 = isRoot && !cont;
        if (!cut && g.u() < (end1 ? d1.phi : d2.phi)) { const D = 1 + Math.floor(Math.exp(Math.min(6, -Math.log(g.u()) / (end1 ? d1.al : d2.al)))); for (let j = 0; j < D; j++) pending.push([cur, false]); }
      }
    }
    return { nodes, cut };
  }
  /* Every parameter: symbol, name in the code, what it sets, the control that moves it, why it matters for collection. */
  const PARAM_ROWS = [
    ['sec', 'How many direct replies a root gets'],
    ['<i>w</i>', ['w'], 'Share of roots that are ordinary. The rest, 1 &minus; <i>w</i>, are the popular group.', 'Roots in the popular group', 'How concentrated replies are, and so the size a quota reaches'],
    ['<i>a</i><sub>1</sub>, <i>t</i><sub>1</sub>', ['a1', 't1'], 'Ordinary roots: how fast the count of direct replies falls off, and how that fall steepens.', 'Reach of the most popular posts', 'The share of roots with a single reply'],
    ['<i>a</i><sub>2</sub>, <i>t</i><sub>2</sub>', ['a2', 't2'], 'Popular roots: lower <i>a</i><sub>2</sub> means more replies; lower <i>t</i><sub>2</sub> means a longer tail of very large roots.', 'Reach of the most popular posts', 'How much sits in conversations of 1,000+ posts'],
    ['sec', 'Whether a reply to the root is answered'],
    ['<i>c</i><sub>0</sub>', ['c0'], 'The chance at a root with one reply, as log-odds.', 'Direct replies that get an answer', 'How many conversations there are per reply'],
    ['<i>c</i><sub>1</sub>', ['c1'], 'How fast that chance falls as the root gets more replies.', null, 'Whether popular roots carry exchanges as well as direct replies'],
    ['<i>s</i><sub>1</sub>', ['s1'], 'How much that chance differs from one conversation to the next.', null, 'How uneven conversations under similar roots are'],
    ['sec', 'Whether a later reply is answered'],
    ['<i>&mu;</i>', ['mu'], 'The chance at a root with one reply, as log-odds.', 'Later replies that get an answer', 'How long exchanges run, and so how many large conversations are quiet-root'],
    ['<i>&gamma;</i>', ['gam'], 'How fast that chance falls as the root gets more replies.', null, 'How much back-and-forth there is under popular roots'],
    ['<i>&sigma;</i>', ['sig'], 'How much that chance differs between conversations.', 'Difference between conversations', 'The few very persistent conversations, which root search misses'],
    ['<i>&tau;</i>', ['tau'], 'How much it differs between exchanges inside one conversation.', null, 'Long side exchanges under an otherwise ordinary conversation'],
    ['sec', 'Whether an exchange splits when it ends'],
    ['<i>g</i><sub>0</sub>, <i>f</i><sub>0</sub>', ['g0', 'f0'], 'Budget for new exchanges, as log-odds: after a reply to the root, and after a later reply.', 'Side threads', 'Conversations that grow large without a popular root'],
    ['<i>f</i><sub>1</sub>', ['f1'], 'How both budgets change as the root gets more replies.', null, 'Side threads under popular roots'],
    ['<i>&alpha;</i><sub>0</sub>', ['alpha0'], 'How many replies a split draws. Higher means fewer.', null, 'Sudden bursts of replies deep in a conversation'],
    ['<i>b</i><sub>1</sub>, <i>b</i><sub>2</sub>', ['b1', 'b2'], 'How much wider splits get under popular roots: after a reply to the root, and after a later reply.', null, 'The same, under popular roots'],
  ];
  function drawParamTable(P) {
    const num = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(Math.abs(v) < 0.1 ? 3 : 2)).replace('-', '&minus;');
    document.getElementById('model-params').innerHTML = '<table class="ptable"><thead><tr><th>Parameter</th><th>Now</th><th>What it sets</th><th>Control that moves it</th><th>Why it matters for collection</th></tr></thead><tbody>'
      + PARAM_ROWS.map((r) => r[0] === 'sec' ? '<tr class="sec"><td colspan="5">' + r[1] + '</td></tr>'
        : '<tr><td class="sym">' + r[0] + '<small>' + r[1].join(', ') + '</small></td><td class="val">' + r[1].map((k) => num(P[k])).join(', ') + '</td><td>' + r[2] + '</td><td class="ctl' + (r[3] ? '' : ' none') + '">' + (r[3] || 'the parameter list only') + '</td><td>' + r[4] + '</td></tr>').join('')
      + '</tbody></table>';
  }
  function drawModel() {
    const P = modelParams(), P0 = CONFIG.models.japan2011.params;
    drawParamTable(P);
    // ---- direct replies to a root: share of roots with at least k
    {
      const f = frame('ch-rootlaw', 250, 'Share of roots with at least a given number of direct replies');
      const m = { l: 54, r: 14, t: 12, b: 40 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t, X = logS(1, 1e5, x0, x1), Y = logS(1e-7, 1, y0, y1);
      for (const [v, lab] of [[1e-6, '0.0001%'], [1e-4, '0.01%'], [1e-2, '1%'], [1, '100%']]) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, lab); }
      for (const v of [1, 10, 100, 1000, 10000, 100000]) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': 'middle', class: 'tick' }, f.svg, int(v)); }
      el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
      el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Roots with at least this many direct replies (log scales)');
      const sf = (p) => { const ls = GRT.rootTable(p); return (k) => Math.exp(ls[Math.min(ls.length - 1, Math.round(Math.log(k) / GRT.DX))]); };
      const cur = sf(P), ref = sf(P0), ks = []; for (let i = 0; i <= 100; i++) ks.push(Math.pow(10, i / 20));
      const line = (fn, col, wd, dash) => { const pts = ks.map((k) => [k, fn(k)]).filter((p) => p[1] >= 1e-7).map((p) => [X(p[0]), Y(p[1])]); el('path', { d: path(pts), fill: 'none', stroke: col, 'stroke-width': wd, 'stroke-dasharray': dash }, f.svg); return pts; };
      const rp = line(ref, 'var(--ref)', 1.5, '5 4'), cp = line(cur, 'var(--ink)', 2.5, null);
      if (rp.length && ref(20) >= 1e-7) el('text', { x: X(20) - 8, y: Y(ref(20)) + 14, 'text-anchor': 'end' }, f.svg, 'Japan 2011 fit');
      for (const k of [10, 100, 1000]) { const v = cur(k); if (v >= 1e-7) { el('circle', { cx: X(k), cy: Y(v), r: 3.5, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 2 }, f.svg); } }
      document.getElementById('sub-rootlaw').textContent = (state.mix > 0 ? 'For the model alone; the US-archive blend is not drawn here. ' : '') + pct(1 - cur(2)) + ' of roots get exactly one direct reply. One root in ' + int(1 / cur(100)) + ' gets 100 or more, and one in ' + int(1 / Math.max(1e-12, cur(1000))) + ' gets 1,000 or more.';
      const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', visibility: 'hidden' }, f.svg), ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
      ov.addEventListener('pointermove', (ev) => { const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width, k = Math.max(1, Math.round(X.inv(px)));
        cross.setAttribute('x1', X(k)); cross.setAttribute('x2', X(k)); cross.setAttribute('visibility', 'visible');
        f.showTip(X(k) * b.width / f.w, ev.clientY - b.top, '<b>' + int(k) + ' or more direct replies</b>' + row('var(--ink)', 'Your settings', pct(cur(k)) + ' of roots') + row('var(--ref)', 'Japan 2011 fit', pct(ref(k)) + ' of roots')); });
      ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    }
    // ---- chance that a reply is answered, by how popular the root is
    {
      const f = frame('ch-answer', 250, 'Chance that a reply is answered, by the number of direct replies to its root');
      const m = { l: 44, r: 14, t: 12, b: 40 }, x0 = m.l, x1 = f.w - m.r, y0 = f.h - m.b, y1 = m.t, X = logS(1, 1e4, x0, x1), Y = lin(0, 1, y0, y1);
      for (const v of [0, 0.25, 0.5, 0.75, 1]) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, f.svg); el('text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, f.svg, Math.round(100 * v) + '%'); }
      for (const v of [1, 10, 100, 1000, 10000]) { el('line', { x1: X(v), x2: X(v), y1: y0, y2: y0 + 5, stroke: 'var(--line-2)' }, f.svg); el('text', { x: X(v), y: y0 + 18, 'text-anchor': 'middle', class: 'tick' }, f.svg, int(v)); }
      el('line', { x1: x0, x2: x1, y1: y0, y2: y0, stroke: 'var(--line-2)' }, f.svg);
      el('text', { x: (x0 + x1) / 2, y: f.h - 6, 'text-anchor': 'middle' }, f.svg, 'Direct replies to the root (log scale)');
      const ks = []; for (let i = 0; i <= 80; i++) ks.push(Math.pow(10, i / 20));
      for (const [direct, col] of [[true, 'var(--ink-2)'], [false, 'var(--quiet)']]) {
        const up = ks.map((k) => [X(k), Y(answerParts(P, k, 1, direct).any)]), dn = ks.map((k) => [X(k), Y(answerParts(P, k, -1, direct).any)]).reverse();
        el('path', { d: path(up.concat(dn)) + 'Z', fill: col, 'fill-opacity': 0.13, stroke: 'none' }, f.svg);
        el('path', { d: path(ks.map((k) => [X(k), Y(answerParts(P, k, 0, direct).any)])), fill: 'none', stroke: col, 'stroke-width': 2.5 }, f.svg);
      }
      legend('leg-answer', [['', 'var(--ink-2)', 'A reply to the root'], ['', 'var(--quiet)', 'A reply to another reply'], ['box', 'var(--ink-3)', 'Two-thirds of conversations fall in the band', 'opacity:.3']]);
      const a1 = answerParts(P, 1, 0, true).any, a100 = answerParts(P, 100, 0, true).any, l1 = answerParts(P, 1, 0, false).any, l100 = answerParts(P, 100, 0, false).any;
      document.getElementById('sub-answer').textContent = 'In a typical conversation a direct reply is answered ' + pct(a1) + ' of the time under a root with one reply and ' + pct(a100) + ' under a root with 100. For later replies it is ' + pct(l1) + ' and ' + pct(l100) + '.';
      const cross = el('line', { y1: y1, y2: y0, stroke: 'var(--ink-3)', visibility: 'hidden' }, f.svg), ov = el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent' }, f.svg);
      ov.addEventListener('pointermove', (ev) => { const b = f.svg.getBoundingClientRect(), px = (ev.clientX - b.left) * f.w / b.width, k = Math.max(1, Math.round(X.inv(px)));
        cross.setAttribute('x1', X(k)); cross.setAttribute('x2', X(k)); cross.setAttribute('visibility', 'visible');
        const r = (direct) => pct(answerParts(P, k, 0, direct).any) + ' (' + pct(answerParts(P, k, -1, direct).any) + ' to ' + pct(answerParts(P, k, 1, direct).any) + ')';
        f.showTip(X(k) * b.width / f.w, ev.clientY - b.top, '<b>Root with ' + int(k) + ' direct ' + (k === 1 ? 'reply' : 'replies') + '</b>' + row('var(--ink-2)', 'Reply to the root', r(true)) + row('var(--quiet)', 'Reply to a reply', r(false))); });
      ov.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); f.hideTip(); });
    }
    // ---- eight conversations
    {
      const host = document.getElementById('ch-trees'), cols = host.clientWidth >= 640 ? 4 : 2, Ks = [3, 12, 40, 150], traits = [[0, 'A typical conversation'], [1.5, 'A persistent one (about 1 in 15)']];
      const cw = Math.floor(host.clientWidth / cols), ch = Math.min(cw, 210), rowsN = cols === 4 ? 2 : 4, headH = 26, capH = 42;
      const f = frame('ch-trees', rowsN * (headH + ch + capH), 'Eight simulated conversations drawn as trees, for roots with 3, 12, 40 and 150 direct replies');
      traits.forEach(([theta, tname], ti) => Ks.forEach((K, ki) => {
        const idx = ti * 4 + ki, colI = cols === 4 ? ki : idx % 2, rowI = cols === 4 ? ti : Math.floor(idx / 2);
        const ox = colI * cw, oy = rowI * (headH + ch + capH), cx = ox + cw / 2, cy = oy + headH + ch / 2, Rm = Math.min(cw, ch) / 2 - 8;
        const sp = specimen(P, K, theta, 1000 + idx, 420), N = sp.nodes;
        // leaves under each node, then angular spans
        const leaves = new Array(N.length).fill(0); for (let i = N.length - 1; i >= 0; i--) { if (!N[i].kids.length) leaves[i] = 1; if (N[i].parent >= 0) leaves[N[i].parent] += leaves[i]; }
        let maxD = 3; for (const nd of N) if (nd.depth > maxD) maxD = nd.depth;
        const a0 = new Array(N.length).fill(0), a1 = new Array(N.length).fill(0); a1[0] = 2 * Math.PI;
        for (let i = 0; i < N.length; i++) { let a = a0[i]; for (const k of N[i].kids) { const span = (a1[i] - a0[i]) * leaves[k] / Math.max(1, leaves[i]); a0[k] = a; a1[k] = a + span; a += span; } }
        const pos = N.map((nd, i) => { const ang = (a0[i] + a1[i]) / 2 - Math.PI / 2, r = i === 0 ? 0 : Rm * Math.sqrt(nd.depth / maxD); return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)]; });
        let dd = ''; for (let i = 1; i < N.length; i++) dd += 'M' + pos[N[i].parent][0].toFixed(1) + ' ' + pos[N[i].parent][1].toFixed(1) + 'L' + pos[i][0].toFixed(1) + ' ' + pos[i][1].toFixed(1);
        el('path', { d: dd, fill: 'none', stroke: 'var(--line-2)', 'stroke-width': 0.8 }, f.svg);
        const rad = N.length > 200 ? 1.5 : N.length > 60 ? 2 : 2.6; let later = 0;
        for (let i = 1; i < N.length; i++) { const lat = N[i].depth > 1; if (lat) later++; el('circle', { cx: pos[i][0].toFixed(1), cy: pos[i][1].toFixed(1), r: rad, fill: lat ? 'var(--quiet)' : 'var(--ink-3)' }, f.svg); }
        el('circle', { cx, cy, r: 4, fill: 'var(--ink)' }, f.svg);
        if (ki === 0 || (cols === 2 && ki % 2 === 0)) el('text', { x: ox + 4, y: oy + 15, class: 'strong' }, f.svg, tname);
        el('text', { x: cx, y: oy + headH + ch + 14, 'text-anchor': 'middle' }, f.svg, K + ' direct replies');
        el('text', { x: cx, y: oy + headH + ch + 28, 'text-anchor': 'middle', class: 'tick' }, f.svg, (sp.cut ? 'over ' : '') + int(N.length) + ' posts, ' + pct(later / Math.max(1, N.length - 1)) + (cols === 4 ? ' below a reply' : ' deeper'));
      }));
    }
  }

  /* ====================================================================== render */
  function facts(id, rows) { document.getElementById(id).innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join(''); }
  function render() {
    const d = last = compute(), R = state.replies, pop = d.pop, at = d.at, c = d.chosen;
    const j100 = E.indexOf(100), j1000 = E.indexOf(1000), need = Math.round(100 * state.recall) + '%', sizeTxt = int(d.cut) + '+ posts';
    facts('facts-pop', [
      ['Replies in conversations of 100+', pct(pop.tierS[j100] - pop.tierW[j100])],
      ['Replies in conversations of 1,000+', pct(pop.tierS[j1000] - pop.tierW[j1000])],
      ['Conversations of 100+ per million replies', big(1e6 * pop.tierW[j100])],
      ['Share of those that are quiet-root', pop.tierW[j100] ? pct(pop.tierQuiet[j100] / pop.tierW[j100]) : '–'],
    ]);
    facts('facts-scale', [['Quota, as a share of reading every reply once', pct(d.budget)], ['Conversations of ' + sizeTxt + ' a month', at ? big(at.tierW * R) : 'none']]);
    // verdict
    const pill = document.getElementById('pill'), head = document.getElementById('headline'), rec = document.getElementById('recipe');
    const setPill = (cls, t) => { pill.className = 'pill ' + cls; pill.textContent = t; };
    if (d.status === 'empty') { setPill('short', 'Nothing this large'); head.textContent = 'This population has no conversations of ' + sizeTxt + '.'; rec.textContent = 'Lower the size, or choose a scenario with larger conversations.'; }
    else if (!c) { setPill('short', 'No plan'); head.textContent = state.allowRoot || state.allowSample ? 'No plan meets the target or fits the quota.' : 'Allow at least one way of finding conversations.'; rec.textContent = state.allowRoot || state.allowSample ? 'Lower the share to find, or raise the size.' : ''; }
    else {
      const name = famName(c), near = (x) => (Math.round(100 * x) === Math.round(100 * state.recall) ? (100 * x).toFixed(1) + '%' : pct(x));
      if (d.status === 'ok') { setPill('ok', 'Fits the quota'); head.textContent = name + ' finds ' + pct(c.recall) + ' of conversations of ' + sizeTxt + ' for ' + big(c.cost * R) + ' units a month, ' + pct(c.cost / d.budget) + ' of the quota.'; }
      else if (d.status === 'short') { setPill('short', 'Below target'); head.textContent = 'No plan tried finds ' + need + ' of conversations of ' + sizeTxt + ' within the quota. The best finds ' + near(c.recall) + '.'; }
      else if (d.status === 'ceiling') { setPill('short', 'Target out of reach'); head.textContent = 'No allowed plan finds ' + need + ' of conversations of ' + sizeTxt + ', at any quota. The best within this quota finds ' + near(c.recall) + '.'; }
      else { setPill('short', 'Over the quota'); head.textContent = 'The cheapest plan that finds ' + need + ' costs ' + big(c.cost * R) + ' units a month, ' + (c.cost / d.budget).toFixed(1) + ' times the quota, and no plan fits within it.'; }
      rec.textContent = recipe(c, d.cut) + (d.status === 'short' ? ' Finding ' + need + ' would cost ' + big(at.atFloor.cost * R) + ' units a month.' : '')
        + (d.status === 'ceiling' ? ' The limit is what the allowed ways of finding can see, not the quota.' : '')
        + (d.status !== 'ok' && d.reach ? ' With this quota you can find ' + need + ' of conversations only from about ' + int(d.reach.size) + ' posts up.' : '');
    }
    const k = [];
    if (c) {
      const returned = (c.finding + c.wasted + c.reading) * R;
      k.push(['Conversations collected a month', big(c.found * R), pct(c.recall) + ' of the ' + big(at.tierW * R) + ' with ' + int(d.cut) + '+ posts, holding ' + pct(c.posts / at.tierPosts) + ' of their posts']);
      k.push(['Units spent a month', big(c.cost * R), pct(c.cost / d.budget) + ' of the quota; about ' + big(returned) + ' posts returned']);
      k.push(['Spent on searching and size checks', pct(1 - c.reading / c.cost), big((c.cost - c.reading) * R) + ' units on root search, the reply sample' + (c.wasted > 0 ? ', counts and discarded downloads' : ' and counts')]);
      k.push(['Quiet-root conversations found', pct(c.cover.foundQuiet), 'against ' + pct(c.cover.foundDriven) + ' of root-driven ones']);
    }
    document.getElementById('kpis').innerHTML = k.map(([a, b, s]) => '<div class="kpi"><div class="k">' + a + '</div><div class="v">' + b + '</div><div class="s">' + s + '</div></div>').join('');
    const st = document.getElementById('status');
    st.innerHTML = tableInfo.kind === 'ref' ? '<b>' + (tableInfo.name === 'japan2011' ? 'Japan 2011 reference' : 'Precomputed scenario') + '</b> · ' + (tableInfo.name === 'japan2011' ? '200M' : big(SCENARIO_TABLES[tableInfo.name].trees)) + ' simulated conversations'
      : '<b>' + (pending ? 'Simulating' : 'Simulated') + '</b> · ' + big(tableInfo.trees) + ' conversations' + (pending ? ' · pass ' + tableInfo.round + ' of ' + tableInfo.rounds : '')
        + (tableInfo.excess > 1e-9 || tableInfo.capped > 1e-9 ? ' · the largest conversations exceed the simulator’s limit and are understated' : '');
    document.getElementById('foot-build').textContent = CONFIG.version + '. Quota and monthly reply volume are placeholders until the contract and the 2024 data say otherwise.';
    document.getElementById('sub-pop').textContent = 'Share of all replies that sit in conversations of at least each size. Grey: Japan 2011 and the US archives. Black: your settings.';
    const clear = (ids) => ids.forEach((id) => { const h = document.getElementById(id); h.querySelectorAll('svg').forEach((x) => x.remove()); });
    if (!at || !c) {
      clear(['ch-logic', 'ch-frontier', 'ch-bars', 'ch-reach', 'ch-cover', 'ch-shape']);
      ['sub-logic', 'sub-frontier', 'sub-bars', 'sub-reach', 'sub-cover', 'note-cover'].forEach((id) => { document.getElementById(id).textContent = id === 'sub-logic' ? 'Nothing to show for these settings.' : ''; });
      ['leg-frontier', 'leg-bars', 'leg-cover'].forEach((id) => { document.getElementById(id).innerHTML = ''; });
      drawPop(d); drawModel(); scheduleRange(); return;
    }
    // captions
    document.getElementById('sub-frontier').textContent = 'Each line shows the most a way of finding can collect at each level of spending, among the plans tried, for conversations of ' + sizeTxt + '. Spending left of the quota line fits.';
    document.getElementById('sub-bars').textContent = 'Each way of finding at its cheapest plan that finds ' + need + ', or at its best within the quota. The darkest part is downloading the conversations; lighter parts are finding them and checking sizes. Root search is shown at half the size if finding ' + need + ' would cost over twice the downloading.';
    document.getElementById('sub-reach').textContent = d.reach ? 'To find ' + need + ' within this quota, collect conversations of about ' + int(d.reach.size) + '+ posts or larger. Points below the quota line fit.'
      : 'No size tried lets this quota find ' + need + '. Points below the quota line fit.';
    document.getElementById('sub-cover').textContent = 'The chance that a conversation of a given size is collected, for root-driven and quiet-root conversations. A gap between the lines means the collection over-represents one kind.';
    const qs = pop.tierW[d.cutBin] ? pop.tierQuiet[d.cutBin] / pop.tierW[d.cutBin] : 0;
    document.getElementById('note-cover').textContent = 'Under these assumptions ' + pct(qs) + ' of conversations of ' + sizeTxt + ' are quiet-root. Root search finds a conversation only if its root has enough direct replies. A reply sample flags larger conversations more often, whatever their shape.';
    drawLogic(d); drawFrontier(d); drawBars(d); drawReach(d); drawCover(d); drawShape(d); drawPop(d); drawModel();
    scheduleRange();
  }

  /* ---- the same settings under every scenario, one column each; computed a column at a time */
  let rangeToken = 0, rangeTimer = 0;
  function scheduleRange() { clearTimeout(rangeTimer); rangeTimer = setTimeout(renderRange, 220); }
  function renderRange() {
    const token = ++rangeToken, names = Object.keys(CONFIG.scenarios), cols = {}, host = document.getElementById('range');
    const act = activeScenario(), R = state.replies, need = Math.round(100 * state.recall) + '%';
    const draw = () => {
      const cell = (name, f) => '<td class="' + (name === act ? 'on' : '') + '">' + (cols[name] ? f(cols[name]) : '<span class="wait">…</span>') + '</td>';
      const rowHtml = (label, f) => '<tr><th scope="row">' + label + '</th>' + names.map((n) => cell(n, f)).join('') + '</tr>';
      const none = (a) => a.status === 'empty' ? '<span class="dim">none this large</span>' : '–';
      const bar = (a) => { const c = a.chosen, sh = c.cost / a.budget, over = a.status !== 'ok'; return '<div class="qbar"><i style="width:' + Math.min(100, 100 * sh).toFixed(1) + '%;background:' + (over ? 'var(--over)' : FAM[c.family].color) + '"></i></div><span class="num">' + big(c.cost * R) + '</span> <span class="dim">' + pct(sh) + ' of quota</span>'; };
      const why = { short: 'the most within the quota', ceiling: need + ' is out of reach', over: 'over the quota' };
      host.innerHTML = '<table class="range"><thead><tr><th></th>' + names.map((n) => '<th scope="col" class="' + (n === act ? 'on' : '') + '"><button type="button" data-sc="' + n + '">' + CONFIG.scenarios[n].label + '</button></th>').join('') + '</tr></thead><tbody>'
        + rowHtml('Replies in conversations of 100+', (a) => '<span class="num">' + pct(a.share100) + '</span>')
        + rowHtml('Quiet-root share of conversations of ' + int(state.cut) + '+ posts', (a) => a.quietShare == null ? none(a) : '<span class="num">' + pct(a.quietShare) + '</span>')
        + rowHtml('Plan shown', (a) => a.chosen ? '<span class="chip" style="background:' + FAM[a.chosen.family].color + '"></span>' + famName(a.chosen) + (a.status !== 'ok' ? '<div class="dim">' + why[a.status] + '</div>' : '') : none(a))
        + rowHtml('Units spent a month', (a) => a.chosen ? bar(a) : none(a))
        + rowHtml('Share found', (a) => a.chosen ? '<span class="num">' + pct(a.chosen.recall) + '</span> <span class="dim">quiet-root ' + pct(a.quiet) + '</span>' : none(a))
        + rowHtml('Spent on searching and size checks', (a) => a.chosen ? '<span class="num">' + pct(1 - a.chosen.reading / a.chosen.cost) + '</span>' : none(a))
        + rowHtml('Root search alone, at half the size', (a) => a.rootOnly ? '<span class="num">' + pct(a.rootOnly.recall) + '</span> <span class="dim">at ' + int(a.rootOnly.T) + '+ replies, ' + big(a.rootOnly.cost * R) + ' units</span>' : none(a))
        + rowHtml('Smallest size the quota reaches', (a) => a.reach ? '<span class="num">about ' + int(a.reach.size) + '+</span>' : a.status === 'empty' ? none(a) : '<span class="dim">none tried</span>')
        + '</tbody></table>';
      host.querySelectorAll('button[data-sc]').forEach((b) => b.addEventListener('click', () => applyScenario(b.dataset.sc)));
    };
    draw();
    let i = 0;
    const step = () => {
      if (token !== rangeToken || i >= names.length) return;
      const name = names[i++], t = scenarioTable(name);
      const pop = COST.buildPop(t.w, t.ws, { wq: t.wq, cap: state.cap || Infinity, descendants: state.minReplies === 'all' });
      const a = analyse(pop, false), j100 = E.indexOf(100);
      a.share100 = pop.tierS[j100] - pop.tierW[j100];
      a.quietShare = a.at && pop.tierW[a.cutBin] ? pop.tierQuiet[a.cutBin] / pop.tierW[a.cutBin] : null;
      a.quiet = a.chosen ? COST.coverage(pop, a.chosen).foundQuiet : null;
      a.rootOnly = a.at && state.allowRoot ? COST.rootPolicy(pop, a.pr, a.cutBin, Math.max(1, Math.floor(E[a.cutBin] / 2)), true) : null;
      cols[name] = a; draw(); setTimeout(step, 0);
    };
    setTimeout(step, 0);
    document.getElementById('sub-range').textContent = 'Your quota, prices and choices, applied to each scenario, for conversations of ' + int(state.cut) + '+ posts with ' + need + ' to be found. Click a column to load it.';
  }

  /* ====================================================================== wiring */
  document.getElementById('btn-reset').addEventListener('click', () => { state = freshState(); refreshControls(); refreshPopulation(); });
  document.getElementById('btn-copy').addEventListener('click', (ev) => {
    const text = JSON.stringify(state, null, 1), btn = ev.currentTarget, done = (t) => { btn.textContent = t; setTimeout(() => { btn.textContent = 'Copy settings'; }, 1600); };
    const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('aria-label', 'Settings'); ta.style.cssText = 'position:fixed;left:16px;bottom:16px;width:320px;height:160px;z-index:20;font:12px monospace'; document.body.appendChild(ta); ta.select(); done('Select and copy'); setTimeout(() => ta.remove(), 15000); };
    try { navigator.clipboard.writeText(text).then(() => done('Copied'), fallback); } catch (e) { fallback(); }
  });
  let rz = 0; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(schedule, 120); });
  buildControls(); refreshControls(); refreshPopulation(); render();
  window.PLANNER = { get state() { return state; }, get last() { return last; }, CONFIG, rerender: schedule,
                     ui: { el, frame, lin, logS, logTicks, path, legend, row, big, pct, int, niceStep } };
})();
