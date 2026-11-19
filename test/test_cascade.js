// Checks of the cascade arithmetic. Exits non-zero if any check fails.
const C = require('../src/cascade_model.js');
let failed = 0;
const check = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + name + ': ' + (+(+got).toPrecision(5)) + ' (expected ' + want + ' +/- ' + tol + ')'); };
const D = C.DATA, sep7 = C.population({ scale: 1, window: 7 }), sep3 = C.population({ scale: 1, window: 3 }), orig = C.population({ scale: 1, window: 7, quoteRooted: false });

// the curves pass through the measured points
D.S.forEach((s, i) => {
  check('cascades of ' + s + '+', sep7.N(s), D.N[i], 1e-6);
  check('posts in cascades of ' + s + '+, quote-rooted included', sep7.P(s) / 1e6, (D.P[i] + D.Q[i]) / 1e6, 1e-6);
  check('posts in cascades of ' + s + '+, original roots only', orig.P(s) / 1e6, D.P[i] / 1e6, 1e-6);
});
check('cascades of 100+', sep7.N(100), 1568662, 1e-3);
check('posts in cascades of 100+: the 1,000+ total plus the 100 to 999 band', sep7.P(100) / 1e6, 384.6 + 376.1, 0.01);
check('tail exponent above 20,000, from the mean size there', sep7.tail, 39046 / 19046, 0.001);
check('about one cascade a month passes 400,000 posts', sep7.N(400000), 1.4, 0.5);
check('curves fall with size', [150, 700, 3000, 8000, 15000, 60000].every((s) => sep7.N(s) > sep7.N(s * 1.1) && sep7.P(s) > sep7.P(s * 1.1)) ? 1 : 0, 1, 0);
check('three days keeps 95.7% of seven', sep3.P(10000) / sep7.P(10000), 0.957, 0.001);
check('every post of cascades of 10,000+, three days', sep3.P(10000) / 1e6, 62.1, 0.05);
check('a month like June', C.population({ scale: D.months.June, window: 7 }).P(1000) / sep7.P(1000), 0.86, 0.001);

// the plan in the design draft: every post from 10,000, replies and quotes below, census of 100+
const base = { full: 10000, rq: 2400, census: 100, passes: 3, rt: 0.85, qt: 0.05, rtMode: 'none', rtN: 100, rtRate: 0.03, stream: 0.01 };
{ const r = C.plan(sep3, base);
  check('tier 1 costs every post', r.cost1 / 1e6, 62.1, 0.05);
  check('tier 1 parts add up', (r.t1.replies + r.t1.quotes + r.t1.retweets) / r.A, 1, 1e-9);
  check('tier 2 costs 15% of the posts between 2,400 and 10,000', r.cost2 / r.B, 0.15, 1e-9);
  check('tier 2 cost', r.cost2 / 1e6, 22.5, 0.6);
  check('cascades in tier 1', r.n1, 3068, 2);
  check('cascades in tier 2', r.n2, 31500, 700);
  check('census: three passes over every root of 100+', r.finding, 3 * sep3.N(100), 1);
  check('total with a 10M reserve fits 100M', r.total + 10e6 <= 100e6 ? 1 : 0, 1, 0);
  check('retweets of tier 2 seen in the 1% stream', r.streamRetweets, 0.01 * 0.85 * r.B, 1);
  check('first 100 retweets of each tier 2 cascade, quote-rooted ones included', C.plan(sep3, Object.assign({}, base, { rtMode: 'first' })).bought / 1e6, 3.5, 0.15);
  check('a 3% bought sample of tier 2 retweets', C.plan(sep3, Object.assign({}, base, { rtMode: 'sample' })).bought, 0.03 * 0.85 * r.B, 1);
  check('first N with N above every size is every retweet', C.plan(sep3, Object.assign({}, base, { rtMode: 'first', rtN: 1e7 })).bought / r.t2.allRetweets, 1, 1e-9); }

// lowest tier 2 edge that fits, as the retweet share moves (10M reserve)
{ const edge = (rt, reserve) => C.lowest(sep3, Object.assign({}, base, { rt }), 'rq', 100e6 - reserve, 100, 10000);
  check('tier 2 edge at 80% retweets', edge(0.80, 10e6), 3200, 200);
  check('tier 2 edge at 85% retweets', edge(0.85, 10e6), 2400, 150);
  check('tier 2 edge at 89% retweets', edge(0.89, 10e6), 1600, 120);
  const e = edge(0.85, 10e6);
  check('at the edge the plan is within budget', C.plan(sep3, Object.assign({}, base, { rq: e })).total <= 90e6 ? 1 : 0, 1, 0);
  check('just below the edge it is not', C.plan(sep3, Object.assign({}, base, { rq: e * 0.98 })).total > 90e6 ? 1 : 0, 1, 0);
  check('nothing fits when tier 1 alone is over budget', C.lowest(sep3, base, 'rq', 50e6, 100, 10000) === null ? 1 : 0, 1, 0); }

// every post with no tiers
{ const none = Object.assign({}, base, { rq: Infinity, census: 1000, passes: 1 });
  check('every post fits 100M from about 6,800 posts (seven days, no census)', C.lowest(sep7, Object.assign({}, none, { passes: 0 }), 'full', 100e6, 1000, 1e6), 6760, 80);
  const r = C.plan(sep3, Object.assign({}, base, { full: Infinity, rq: 1000 }));
  check('no cascade in full: tier 1 is empty', r.cost1 + r.n1, 0, 0);
  check('replies and quotes from 1,000 at 85% retweets', r.cost2 / 1e6, 55.2, 0.1); }

check('1% stream sees a 100-post cascade', C.binomSf(1, 100, 0.01), 0.634, 0.001);
console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nall checks passed');
process.exit(failed ? 1 : 0);
