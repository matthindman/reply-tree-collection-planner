/* Calibrate a full parameter set, "best guess today", to pooled prior targets.

   usage: node data/calibrate_today.js [targets.json]     (writes the `today` entry of data/scenarios.json)
   Unlike calibrate.js, the root law's second component (a2, t2) and the mixture weight w are free, so the
   upper tail of direct replies can bend instead of only stretching. Default targets pool the two desk
   assessments in ../collection_strategy_2026_11_19/priors/. A targets file may override them and may give
   `start` (18 parameters) to begin from. This is a calibration to judgements, not a fit to data. */
const fs = require('fs'), path = require('path');
const G = require('../src/sim.js');
const E = G.EDGES, NB = G.NB;
const BASE = { w: 0.5655484, a1: 1.5781099, t1: 1.2234419, a2: 2.0912357, t2: 0.0100002, alpha0: 3.9668806, b1: 0.0347892, b2: 0.035352,
  c0: 0.8176346, c1: 1.4687561, s1: 1.783306, g0: -2.7786261, mu: -0.527664, gam: 0.3392188, sig: 0.9014904, tau: 0.3806759, f0: -2.1083761, f1: -0.4869628 };
let T = { share100: 0.12, share1000: 0.0275, share10000: 0.003, conv100: 410, driven: 0.80, conv: 250000 };
let start = null, source = 'pooled Opus and GPT Pro assessments (2026-11-19)';
if (process.argv[2]) { const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); T = Object.assign(T, j.targets || {}); start = j.start || null; source = j.source || process.argv[2]; }
const W8 = { share100: 5, share1000: 3, share10000: 0.6, conv100: 3, driven: 2, conv: 0.4 };
function stats(W, WS) {
  let rep = 0; for (let c = 0; c < W.length; c++) rep += WS[c] - W[c];
  const o = { share100: 0, share1000: 0, share10000: 0, conv100: 0, conv1000: 0, conv: 0, share20: 0 }; let q = 0;
  for (let i = 0; i < NB; i++) for (let k = 0; k < NB; k++) {
    const c = i * NB + k, x = W[c]; if (!x) continue; o.conv += x;
    const m = WS[c] / x, kmid = k < 20 ? E[k] : Math.sqrt(E[k] * ((k + 1 < NB ? E[k + 1] : 2 * E[k]) - 1));
    if (E[i] >= 20) o.share20 += WS[c] - x;
    if (E[i] >= 100) { o.share100 += WS[c] - x; o.conv100 += x; if (kmid < (m - 1) / 2) q += x; }
    if (E[i] >= 1000) { o.share1000 += WS[c] - x; o.conv1000 += x; }
    if (E[i] >= 10000) o.share10000 += WS[c] - x;
  }
  o.driven = 1 - q / o.conv100;
  for (const s of ['share20', 'share100', 'share1000', 'share10000']) o[s] /= rep;
  for (const s of ['conv100', 'conv1000', 'conv']) o[s] *= 1e6 / rep;
  return o;
}
const KEYS = ['w', 'a2', 't2', 'dC0', 'dMu', 'sigScale', 'dBranch'];
const LO = [0.15, -3, 0.02, -3.5, -1.5, 0.4, -1.5], HI = [0.97, 3, 1.6, 2, 2, 1.6, 1.5];
const b0 = start || BASE;
const build = (x) => { const p = Object.assign({}, b0); p.w = x[0]; p.a2 = x[1]; p.t2 = x[2]; p.c0 = b0.c0 + x[3]; p.mu = b0.mu + x[4]; p.sig = b0.sig * x[5]; p.f0 = b0.f0 + x[6]; p.g0 = b0.g0 + x[6]; return p; };
const logit = (p) => Math.log(p / (1 - p));
const run = (p, rounds) => { const r = G.simulate(p, { seed: 777, rounds, budget: 2e6 }); return stats(r.W, r.WS); };
function loss(x) {
  for (let i = 0; i < x.length; i++) if (x[i] < LO[i] || x[i] > HI[i]) return 1e6;
  const s = run(build(x), 2); let L = 0;
  for (const k of ['share100', 'share1000', 'share10000', 'conv100', 'conv']) L += W8[k] * Math.pow(Math.log(Math.max(s[k], 1e-7) / T[k]), 2);
  L += W8.driven * Math.pow(logit(Math.min(0.999, Math.max(0.001, s.driven))) - logit(T.driven), 2);
  return L + 0.005 * (x[3] * x[3] + x[4] * x[4] + x[6] * x[6] + Math.pow((x[5] - 1) / 0.5, 2));
}
function nm(f, x0, step, iters) {
  const n = x0.length; let sim = [x0.slice()]; for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step[i]; sim.push(x); }
  let val = sim.map(f);
  for (let it = 0; it < iters; it++) {
    const idx = val.map((v, i) => i).sort((a, b) => val[a] - val[b]); sim = idx.map((i) => sim[i]); val = idx.map((i) => val[i]);
    const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += sim[i][j] / n;
    const pt = (a) => c.map((cj, j) => cj + a * (sim[n][j] - cj)), xr = pt(-1), fr = f(xr);
    if (fr < val[0]) { const xe = pt(-2), fe = f(xe); if (fe < fr) { sim[n] = xe; val[n] = fe; } else { sim[n] = xr; val[n] = fr; } }
    else if (fr < val[n - 1]) { sim[n] = xr; val[n] = fr; }
    else { const xc = pt(fr < val[n] ? -0.5 : 0.5), fc = f(xc); if (fc < Math.min(fr, val[n])) { sim[n] = xc; val[n] = fc; } else for (let i = 1; i <= n; i++) { sim[i] = sim[i].map((v, j) => sim[0][j] + 0.5 * (v - sim[0][j])); val[i] = f(sim[i]); } }
  }
  const b = val.indexOf(Math.min.apply(null, val)); return { x: sim[b], f: val[b] };
}
const t0 = Date.now();
let best = null;
for (const s of [[0.8, 0.9, 0.3, -0.5, 0.2, 1.1, 0.2], [0.9, 0.3, 0.5, -1, 0.3, 1.1, 0], [0.7, 1.4, 0.15, -0.3, 0.3, 1.2, 0.2]]) {
  let r = nm(loss, start ? [b0.w, b0.a2, b0.t2, 0, 0, 1, 0] : s, [0.06, 0.4, 0.12, 0.5, 0.3, 0.12, 0.3], 70);
  r = nm(loss, r.x, [0.03, 0.15, 0.05, 0.2, 0.12, 0.05, 0.12], 40);
  console.log('start', JSON.stringify(s), 'loss', r.f.toFixed(3), ((Date.now() - t0) / 1000).toFixed(0) + 's');
  if (!best || r.f < best.f) best = r;
  if (start) break;
}
const params = build(best.x); for (const k in params) params[k] = +params[k].toPrecision(6);
const achieved = run(params, 12);
const file = path.join(__dirname, 'scenarios.json'), all = JSON.parse(fs.readFileSync(file, 'utf8'));
all.today = { label: 'Best guess today', source, targets: T, params, achieved, loss: best.f };
fs.writeFileSync(file, JSON.stringify(all, null, 1));
console.log('params', JSON.stringify(params));
console.log('targets ', JSON.stringify(T));
console.log('achieved', JSON.stringify(Object.fromEntries(Object.entries(achieved).map(([k, v]) => [k, +v.toPrecision(3)]))));
