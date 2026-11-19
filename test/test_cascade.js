// Checks of the cascade arithmetic. Exits non-zero if any check fails.
const C = require('../src/cascade_model.js');
let failed = 0;
const check = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + name + ': ' + (+got.toPrecision(5)) + ' (expected ' + want + ' +/- ' + tol + ')'); };
const inp = { n1000: 122000, p1000: 340e6, q1000: 45e6, rt: 0.87, nAll: 1.57e6 }, pop = C.population(inp);
const base = { cut: 1000, quotes: true, under: 0, rtMode: 'none', rtN: 1000, rtShare: 1, days: 3, stream: 0.01, streamInCap: false, streamVolume: 0, hits: 1 };
check('mean size above 1,000', pop.mean, 2786.9, 0.1);
check('tail exponent', pop.a, 1.5596, 0.001);
check('cascades of 1,000+', pop.N(1000), 122000, 1e-6);
check('posts in cascades of 1,000+', pop.P(1000), 340e6, 1e-3);
check('size floor the 1.57M corresponds to', pop.floorOfAll, 194, 3);
// the tail formula against brute-force integration of the Pareto density
{ const a = pop.a; let n = 0, p = 0, capped = 0; const M = 1000, s0 = 2000;
  for (let i = 0; i < 400000; i++) { const lo = s0 * Math.pow(1e5, i / 400000), hi = s0 * Math.pow(1e5, (i + 1) / 400000), mid = Math.sqrt(lo * hi), w = pop.N(lo) - pop.N(hi); n += w; p += w * mid; capped += w * Math.min(inp.rt * mid, M); }
  check('posts in cascades of 2,000+, formula against integration', pop.P(2000) / p, 1, 0.01);
  check('first 1,000 retweets of each cascade of 2,000+, formula against integration', pop.rtFirst(2000, M) / capped, 1, 0.005);
  check('first 1,000 retweets when every cascade has more than that', pop.rtFirst(5000, 1000), pop.N(5000) * 1000, 1e-3); }
// the plan worked out by hand in the session: replies and quotes for every cascade of 1,000+
{ const r = C.plan(pop, base);
  check('1% stream flags cascades of 1,000+', r.found, 1, 1e-4);
  check('replies and roots', r.replies / 1e6, 0.13 * 340, 0.05);
  check('quotes', r.quotes / 1e6, 45, 0.01);
  check('size checks: 3 days for every cascade of 500+', r.checks, 3 * pop.N(500), 1);
  check('total, replies and quotes', r.total / 1e6, 44.2 + 45 + 3 * pop.N(500) / 1e6, 0.05);
  check('retweets seen in the 1% sample', r.sampledRt / 1e6, 0.01 * 0.87 * 340, 0.01);
  const all = C.plan(pop, Object.assign({}, base, { rtMode: 'all' }));
  check('everything, retweets included', all.total / 1e6, 385 + 3 * pop.N(500) / 1e6, 0.1);
  const cutAll = C.reach(pop, Object.assign({}, base, { rtMode: 'all' }), 100e6);
  check('size from which everything fits a 100M cap', cutAll, 12000, 1500);
  check('at that size the plan is within the cap', C.plan(pop, Object.assign({}, base, { rtMode: 'all', cut: cutAll })).total <= 100e6 ? 1 : 0, 1, 0);
  check('1% stream flags cascades of 100+ (one hit)', C.flagged(pop, 100, 0.01, 1), 0.80, 0.06);
  check('no stream: finding costs a daily search hit per watched root', C.plan(pop, Object.assign({}, base, { stream: 0 })).finding, 3 * pop.N(500), 1); }
console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nall checks passed');
process.exit(failed ? 1 : 0);
