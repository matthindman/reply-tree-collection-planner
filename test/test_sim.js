// Compare the JS simulator with the Python reference table for Japan 2011.
const G = require('../src/sim.js'), REF = require('../src/ref_tables.js');
const NISHI = { w: 0.5655483960764812, a1: 1.5781099212733267, t1: 1.2234419126940008, a2: 2.0912357493520117, t2: 0.010000182167590473, alpha0: 3.9668805579418307, b1: 0.03478924854183259, b2: 0.03535202554346883, c0: 0.8176345704638479, c1: 1.4687560653988543, s1: 1.783306033298279, g0: -2.778626104430059, mu: -0.5276639727412965, gam: 0.3392187754657905, sig: 0.9014903848810908, tau: 0.38067586763381717, f0: -2.108376084534991, f1: -0.4869628489773618 };
console.log('logQ checks', G.logQ(0), Math.log(0.5), G.logQ(1.999999), G.logQ(2.000001), G.logQ(5), Math.log(2.866515718791933e-7), 'zeta(2)', G.zeta(2), Math.PI ** 2 / 6, 'zeta(1.2)', G.zeta(1.2));
function summary(w, ws) {
  const NB = G.NB, E = G.EDGES, out = {};
  let conv = 0; for (let c = 0; c < w.length; c++) conv += w[c];
  out.convPerM = 1e6 * conv;
  for (const s of [20, 50, 100, 200, 500, 1000]) {
    const j = E.indexOf(s); let t = 0, p = 0, rd = 0;
    for (let i = j; i < NB; i++) for (let k = 0; k < NB; k++) { const c = i * NB + k; t += w[c]; p += ws[c] - w[c]; if (k >= E.indexOf(s / 2 >= 20 ? E.filter(e => e <= s / 2).pop() : s / 2)) rd += w[c]; }
    out['S' + s] = { treesPerM: +(1e6 * t).toFixed(3), share: +(100 * p).toFixed(4), rootVisible: +(100 * rd / t).toFixed(1) };
  }
  for (const T of [10, 25, 50, 100]) { const j = E.indexOf(T); let t = 0; for (let i = 0; i < NB; i++) for (let k = j; k < NB; k++) t += w[i * NB + k]; out['K' + T] = +(1e6 * t).toFixed(1); }
  return out;
}
const ref = REF.japan2011, rw = new Float64Array(G.NB * G.NB), rws = new Float64Array(G.NB * G.NB);
for (const [i, k, W, m] of ref.cells) { rw[i * G.NB + k] = W; rws[i * G.NB + k] = W * m; }
console.log('PYTHON REF', JSON.stringify(summary(rw, rws)));
for (const seed of [1, 2, 3]) {
  const t0 = Date.now();
  const res = G.simulate(NISHI, { seed, rounds: +(process.argv[2] || 4), budget: 2.5e6 });
  const { w, ws } = G.normalise(res.W, res.WS);
  console.log('JS seed', seed, (Date.now() - t0) + 'ms', res.trees, 'trees', JSON.stringify(summary(w, ws)));
}
