// Checks of the simulator against the 200-million-conversation Python reference for Japan 2011.
// Exits non-zero if any check fails. usage: node test/test_sim.js [rounds]
const G = require('../src/sim.js'), REF = require('../src/ref_tables.js');
const E = G.EDGES, NB = G.NB;
const NISHI = { w: 0.5655483960764812, a1: 1.5781099212733267, t1: 1.2234419126940008, a2: 2.0912357493520117, t2: 0.010000182167590473, alpha0: 3.9668805579418307, b1: 0.03478924854183259, b2: 0.03535202554346883, c0: 0.8176345704638479, c1: 1.4687560653988543, s1: 1.783306033298279, g0: -2.778626104430059, mu: -0.5276639727412965, gam: 0.3392187754657905, sig: 0.9014903848810908, tau: 0.38067586763381717, f0: -2.108376084534991, f1: -0.4869628489773618 };
let failed = 0;
const check = (name, got, want, rel) => { const ok = Math.abs(got - want) <= rel * Math.abs(want); if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + name + ': ' + (+got.toPrecision(5)) + ' (reference ' + (+want.toPrecision(5)) + ', tolerance ' + 100 * rel + '%)'); };
function summary(w, ws, wq) {
  const o = { conv: 0, s20: 0, s100: 0, s200: 0, c100: 0, q100: 0, k10: 0, k50: 0 };
  for (let i = 0; i < NB; i++) for (let k = 0; k < NB; k++) {
    const c = i * NB + k, x = w[c]; if (!x) continue; o.conv += x;
    if (E[i] >= 20) o.s20 += ws[c] - x; if (E[i] >= 100) { o.s100 += ws[c] - x; o.c100 += x; o.q100 += wq[c]; } if (E[i] >= 200) o.s200 += ws[c] - x;
    if (E[k] >= 10) o.k10 += x; if (E[k] >= 50) o.k50 += x;
  }
  return o;
}
check('standard normal tail at 5', G.logQ(5), Math.log(2.866515718791933e-7), 1e-9);
check('zeta(2)', G.zeta(2), Math.PI ** 2 / 6, 1e-8);
const ref = { w: new Float64Array(NB * NB), ws: new Float64Array(NB * NB), wq: new Float64Array(NB * NB) };
for (const [i, k, x, m, q] of REF.japan2011.cells) { ref.w[i * NB + k] = x; ref.ws[i * NB + k] = x * m; ref.wq[i * NB + k] = x * q; }
const R = summary(ref.w, ref.ws, ref.wq), rounds = +(process.argv[2] || 8);
for (const seed of [1, 2, 3]) {
  const t0 = Date.now(), res = G.simulate(NISHI, { seed, rounds, budget: 2.5e6 }), t = G.normalise(res.W, res.WS, res.WQ), S = summary(t.w, t.ws, t.wq);
  console.log('seed ' + seed + ': ' + res.trees + ' conversations in ' + (Date.now() - t0) + ' ms');
  check('  conversations per reply', S.conv, R.conv, 0.005);
  check('  share of replies in 20+', S.s20, R.s20, 0.02);
  check('  share of replies in 100+', S.s100, R.s100, 0.06);
  check('  share of replies in 200+', S.s200, R.s200, 0.12);
  check('  conversations of 100+', S.c100, R.c100, 0.06);
  check('  quiet-root share of 100+', S.q100 / S.c100, R.q100 / R.c100, 0.08);
  check('  roots with 10+ direct replies', S.k10, R.k10, 0.02);
  check('  roots with 50+ direct replies', S.k50, R.k50, 0.04);
  if (res.excess > 0 || res.capped > 0) { failed++; console.log('FAIL   a conversation hit a size guard'); }
}
console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nall checks passed');
process.exit(failed ? 1 : 0);
