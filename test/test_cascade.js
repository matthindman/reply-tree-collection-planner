// Checks of the cascade arithmetic. Exits non-zero if any check fails.
// Where it can, a check recomputes its expected value from the measured tables, not from the model's own functions.
const C = require('../src/cascade_model.js');
let failed = 0;
const check = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + name + ': ' + (+(+got).toPrecision(6)) + ' (expected ' + (+(+want).toPrecision(6)) + ' +/- ' + tol + ')'); };
const yes = (name, cond) => check(name, cond ? 1 : 0, 1, 0);
const D = C.DATA, M = 1e6;
const sep7 = C.population({ window: 7 }), sep3 = C.population({ window: 3 }), orig7 = C.population({ window: 7, quoteRooted: false });

// the curves pass through the measured points
D.S.forEach((s, i) => {
  check('cascades of ' + s + '+, original roots', sep7.N(s), D.N[i], 1e-6);
  check('posts in cascades of ' + s + '+, original roots', orig7.P(s) / M, D.P[i] / M, 1e-4);
  check('posts in cascades of ' + s + '+, quote-rooted included', sep7.P(s) / M, (D.P[i] + D.Q[i]) / M, 1e-4);
});
check('cascades of 100+, original roots', sep7.N(100), 1568662, 1e-3);
check('posts in cascades of 100+: the 1,000+ total plus the 100 to 999 band', sep7.P(100) / M, 384.6 + 376.1, 0.01);

// counts and posts describe one population: summing sizes over the count curve gives the measured posts in each band
const sumSizes = (pop, a, b) => { let t = 0, x = a; const n = 2000; for (let i = 1; i <= n; i++) { const y = a * Math.pow(b / a, i / n); t += (pop.N(x) - pop.N(y)) * Math.sqrt(x * y); x = y; } return t; };
[[1000, 5000], [5000, 10000], [10000, 20000]].forEach(([a, b], i) => check('sizes summed over the counts, ' + a + ' to ' + b, sumSizes(orig7, a, b) / M, (D.P[i] - D.P[i + 1]) / M, 0.02));
[1000, 2300, 7000, 15000].forEach((s) => check('cascades leaving at ' + s + ' posts have about that size', (orig7.P(s) - orig7.P(s * 1.001)) / (orig7.N(s) - orig7.N(s * 1.001)), s * 1.0005, s * 0.001));
yes('each band bends less than its slope, so counts fall with size', C.BASE.bands.every((b) => Math.abs(b.c) < b.L));
yes('counts and posts fall with size everywhere', (() => { for (let s = 100; s < 1e6; s *= 1.01) if (!(sep7.N(s) > sep7.N(s * 1.01) && sep7.P(s) > sep7.P(s * 1.01) && sep7.NQ(s) > sep7.NQ(s * 1.01))) return false; return true; })());
check('tail exponent above 20,000, from the mean size there', sep7.tail, 39046 / 19046, 0.001);
check('about one cascade a month passes 400,000 posts', sep7.N(400000), 1.4, 0.5);

// quote-rooted cascades: estimated band by band from their posts
check('quote-rooted cascades of 10,000+', sep7.NQ(10000), 671 * 0.9 / 26.2 + (4.7 - 0.9) / (60.2 - 26.2) * (3206 - 671), 0.01);
check('none when they are not counted', orig7.NQ(1000) + orig7.P(1000) - orig7.PO(1000), 0, 0);
check('all roots are the two kinds together', sep7.NA(5000), sep7.N(5000) + sep7.NQ(5000), 1e-9);

// shorter windows shrink every cascade by one factor, set from the count of cascades of 10,000+
check('cascades of 10,000+ in three days (the factor is set from this)', sep3.N(10000), 3069, 1e-3);
check('their posts, original roots: measured as 57.6M, not used to set the factor', sep3.PO(10000) / M, 57.6, 0.15);
check('their posts, quote-rooted included', sep3.P(10000) / M, 57.6 / 60.2 * 64.9, 0.2);
{ const d1 = C.population({ window: 1, quoteRooted: false }), d2 = C.population({ window: 2, quoteRooted: false }), d3 = C.population({ window: 3, quoteRooted: false });
  check('cascades of 10,000+ in one day', d1.N(10000), 0.664 * 3206, 1e-3);
  check('cascades of 10,000+ in two days (an estimate)', d2.N(10000), 0.91 * 3206, 1e-3);
  yes('a shorter window shrinks more', d1.shrink < d2.shrink && d2.shrink < d3.shrink && d3.shrink < 1 && orig7.shrink === 1);
  yes('and has fewer cascades and posts at every size', [100, 1000, 3000, 10000, 50000].every((s) => d1.N(s) < d2.N(s) && d2.N(s) < d3.N(s) && d3.N(s) < orig7.N(s) && d1.P(s) < d2.P(s) && d2.P(s) < d3.P(s) && d3.P(s) < orig7.P(s)));
  // a cascade of s posts in one day is one of s / shrink posts in seven, holding shrink times its seven-day posts
  check('one day is seven days shrunk, counts', d1.N(4000), orig7.N(4000 / d1.shrink), 1e-6);
  check('one day is seven days shrunk, posts', d1.P(4000), d1.shrink * orig7.P(4000 / d1.shrink), 1e-3);
  check('counts and posts still describe one population', (d1.P(3000) - d1.P(3003)) / (d1.N(3000) - d1.N(3003)), 3001.5, 3);
  yes('one and two days are marked rough, three and seven are not', d1.windowRough && d2.windowRough && !d3.windowRough && !orig7.windowRough); }
check('a month like June', C.population({ scale: D.months.June, window: 7 }).P(1000) / sep7.P(1000), 710.3 / 825.9, 1e-9);
check('a 31-day month', C.population({ scale: 31 / 30, window: 3 }).N(10000), 3069 * 31 / 30, 1e-3);

// the plan: every post from 10,000, replies and quotes below, search passes over every root of 100+
const base = { full: 10000, rq: 2750, census: 100, passes: 3, rt: 0.85, qt: 0.05, rtMode: 'none', rtN: 100, rtRate: 0.03, stream: 0.01 };
const but = (o) => Object.assign({}, base, o);
{ const r = C.plan(sep3, base);
  check('tier 1 costs every post', r.cost1 / M, 57.6 / 60.2 * 64.9, 0.2);
  check('tier 1 parts add up', (r.t1.replies + r.t1.quotes + r.t1.retweets) / r.A, 1, 1e-9);
  check('tier 2 costs 15% of the posts between 2,750 and 10,000', r.cost2 / r.B, 0.15, 1e-9);
  check('cascades in tier 1', r.n1, 3069, 1e-3);
  check('search passes: three over every root of 100+, quote-rooted included', r.finding, 3 * (sep3.N(100) + sep3.NQ(100)), 1e-3);
  check('no passes cost nothing', C.plan(sep3, but({ passes: 0 })).finding, 0, 0);
  check('passes left out means one', C.plan(sep3, but({ passes: undefined })).finding, r.roots, 1e-6);
  yes('the plan with a 10M reserve fits 100M', r.total + 10e6 <= 100e6);
  check('retweets of tier 2 seen in the 1% stream', r.streamRetweets, 0.01 * 0.85 * r.B, 1);
  // every cascade of 2,750+ posts has more than 100 retweets at 85%, so the first 100 of each cost 100 a cascade
  check('first 100 retweets of each tier 2 cascade', C.plan(sep3, but({ rtMode: 'first' })).bought, 100 * (r.n2 + r.q2), 1);
  check('a 3% bought sample of tier 2 retweets', C.plan(sep3, but({ rtMode: 'sample' })).bought, 0.03 * 0.85 * r.B, 1);
  check('first N with N above every size is every retweet', C.plan(sep3, but({ rtMode: 'first', rtN: 1e9 })).bought / r.t2.allRetweets, 1, 1e-9);
  const open = C.plan(sep3, but({ full: Infinity, rq: 1000, rtMode: 'first', rtN: 1e9 }));
  check('the same with no cascade in full, tail included', open.bought / open.t2.allRetweets, 1, 1e-9); }

// lowest tier 2 edge that fits, as the retweet share moves (10M reserve)
{ const edge = (rt, reserve) => C.lowest(sep3, but({ rt }), 'rq', 100e6 - reserve, 100, 10000);
  check('tier 2 edge at 80% retweets', edge(0.80, 10e6), 3590, 40);
  check('tier 2 edge at 85% retweets', edge(0.85, 10e6), 2745, 40);
  check('tier 2 edge at 89% retweets', edge(0.89, 10e6), 1910, 40);
  { const d1 = C.population({ window: 1 }), e1 = C.lowest(d1, but({ passes: 1 }), 'rq', 90e6, 100, 10000);
    yes('a one-day window lets the second tier reach below 1,000 posts', e1 > 400 && e1 < 800 && C.plan(d1, but({ passes: 1, rq: e1 })).total <= 90e6 + 1); }
  [0.80, 0.85, 0.89].forEach((rt) => { const e = edge(rt, 10e6);
    yes('at the edge the plan is within budget, ' + rt, C.plan(sep3, but({ rt, rq: e })).total <= 90e6 + 1);
    yes('just below the edge it is not, ' + rt, C.plan(sep3, but({ rt, rq: e * 0.99 })).total > 90e6); });
  yes('nothing fits when tier 1 alone is over budget', C.lowest(sep3, base, 'rq', 50e6, 100, 10000) === null);
  yes('no budget, no answer', C.lowest(sep3, base, 'rq', 0, 100, 10000) === null && C.lowest(sep3, base, 'rq', NaN, 100, 10000) === null && C.lowest(sep3, base, 'rq', -5, 100, 10000) === null);
  const far = C.lowest(sep3, but({ full: Infinity, passes: 0 }), 'rq', 1e6, 100, Infinity);
  yes('an open upper limit still gives a finite size', far > 1000 && far < 1e8 && C.plan(sep3, but({ full: Infinity, passes: 0, rq: far })).total <= 1e6 + 1);
  yes('and an answer however small the budget', C.lowest(sep3, but({ rq: Infinity, passes: 0 }), 'full', 1000, 1000, Infinity) <= 1e8);
  check('nothing at or above 100 million posts', sep3.NA(1e8) + sep3.P(1e8) + C.firstRetweets(sep3, 1e8, Infinity, 0.85, 100), 0, 0); }

// the other splits in the design draft (85% retweets, 10M reserve, three passes)
{ const none = C.plan(sep3, but({ full: Infinity, rq: 1000 })), left = 90e6 - none.total;
  check('replies and quotes from 1,000, no cascade in full', none.total / M, 61.1, 0.1);
  yes('the first 200 retweets of each fit what is left', C.plan(sep3, but({ full: Infinity, rq: 1000, rtMode: 'first', rtN: 200 })).bought <= left);
  yes('the first 250 do not', C.plan(sep3, but({ full: Infinity, rq: 1000, rtMode: 'first', rtN: 250 })).bought > left);
  check('or a random sample of this share', left / none.t2.allRetweets, 0.091, 0.002);
  check('replies and quotes from 1,000, then every post from', C.lowest(sep3, but({ rq: 1000 }), 'full', 90e6, 1000, 1e6), 16320, 150);
  check('every post and no second tier, from', C.lowest(sep3, but({ rq: Infinity }), 'full', 90e6, 1000, 1e6), 7660, 80);
  check('every post, seven days, whole cap, no search passes, from', C.lowest(sep7, but({ rq: Infinity, passes: 0 }), 'full', 100e6, 1000, 1e6), 6880, 80);
  const r = C.plan(sep3, but({ full: Infinity, rq: 1000 }));
  check('no cascade in full: tier 1 is empty', r.cost1 + r.n1 + r.q1, 0, 0);
  check('replies and quotes from 1,000 cost 15% of every post there', r.cost2, 0.15 * sep3.P(1000), 1); }

check('1% stream sees a 100-post cascade', C.binomSf(1, 100, 0.01), 0.634, 0.001);
check('at least no sampled posts is certain', C.binomSf(0, 100, 0.01), 1, 0);
console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nall checks passed');
process.exit(failed ? 1 : 0);
