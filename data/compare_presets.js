/* Simulate parameter sets with the planner's simulator and print comparable summary statistics.
   usage: node data/compare_presets.js name=path.json [name=path.json ...]   (each JSON has a `params` object) */
const fs = require('fs'), G = require('../src/sim.js'), C = require('../src/cost.js');
const E = G.EDGES, NB = G.NB;
function stats(p, seed) {
  const r = G.simulate(p, { seed, rounds: 14, budget: 2.5e6 }); let rep = 0; for (let c = 0; c < r.W.length; c++) rep += r.WS[c] - r.W[c];
  const o = { s10: 0, s20: 0, s50: 0, s100: 0, s200: 0, s500: 0, s1000: 0, s10000: 0, c100: 0, c1000: 0, conv: 0, k1: 0, k5: 0, k10: 0, k25: 0, k50: 0, k100: 0, k1000: 0, quiet: 0, kle2: 0, direct100: 0, direct: 0 };
  for (let i = 0; i < NB; i++) for (let k = 0; k < NB; k++) {
    const c = i * NB + k, x = r.W[c]; if (!x) continue; const m = r.WS[c] / x, rp = r.WS[c] - x;
    const kmid = k < 20 ? E[k] : Math.sqrt(E[k] * ((k + 1 < NB ? E[k + 1] : 2 * E[k]) - 1));
    o.conv += x; o.direct += x * Math.min(kmid, m - 1);
    for (const s of [10, 20, 50, 100, 200, 500, 1000, 10000]) if (E[i] >= s) o['s' + s] += rp;
    if (E[k] === 1) o.k1 += x; for (const s of [5, 10, 25, 50, 100, 1000]) if (E[k] >= s) o['k' + s] += x;
    if (E[i] >= 100) { o.c100 += x; if (kmid < (m - 1) / 2) o.quiet += x; if (kmid <= 2) o.kle2 += x; o.direct100 += x * Math.min(kmid, m - 1); }
    if (E[i] >= 1000) o.c1000 += x;
  }
  const out = { trees: r.trees };
  for (const s of [10, 20, 50, 100, 200, 500, 1000, 10000]) out['share' + s] = o['s' + s] / rep;
  out.conv100 = 1e6 * o.c100 / rep; out.conv1000 = 1e6 * o.c1000 / rep; out.conv = 1e6 * o.conv / rep;
  out.rootsK1 = o.k1 / o.conv; for (const s of [5, 10, 25, 50, 100, 1000]) out['rootsK' + s] = o['k' + s] / o.conv;
  out.driven = 1 - o.quiet / o.c100; out.kle2 = o.kle2 / o.c100; out.directAll = o.direct / rep; out.direct100 = o.direct100 / o.s100;
  // root search at each threshold: recall of 100+ conversations and of their replies
  const t = G.normalise(r.W, r.WS), pop = C.buildPop(t.w, t.ws), j = E.indexOf(100);
  for (const T of [10, 25, 50, 100]) { const pol = C.rootPolicy(pop, {}, j, T, true); out['rootT' + T] = pol.recall; out['candT' + T] = 1e6 * pol.cand; }
  return out;
}
const rows = {}, names = [];
for (const a of process.argv.slice(2)) { const [name, file] = a.split('='); const p = JSON.parse(fs.readFileSync(file, 'utf8')).params; names.push(name); rows[name] = stats(p, 31337); }
const keys = Object.keys(rows[names[0]]);
console.log(['stat'].concat(names).join('\t'));
for (const k of keys) console.log([k].concat(names.map((n) => { const v = rows[n][k]; return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : (100 * v).toPrecision(3) + '%'; })).join('\t'));
