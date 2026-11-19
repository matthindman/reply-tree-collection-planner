/* cascade_model.js — arithmetic for collecting cascades in tiers, on measured size tables.

   A cascade is the posts sharing one conversation ID (the root and its replies at any depth) plus every
   retweet and quote of those posts. Its size leaves the root out. A quote that is not a reply is a leaf of
   the cascade it quotes and the root of its own.

   DATA holds counts for September 2026 from the full Japanese stream (seven-day window). Between the
   measured sizes the curves are straight lines on log-log axes. Above 20,000 posts they follow a power
   law set by the mean size there. Below 1,000 only one count exists, made under an earlier definition,
   so everything below 1,000 is rough.

   Three tiers: every post for cascades of `full`+ posts; replies and quotes for cascades of `rq`+;
   the root and its counts for cascades of `census`+. Costs are in units: one unit is the charge for one
   post returned. No DOM access. */
(function (root) {
  'use strict';

  const DATA = {
    S: [1000, 5000, 10000, 20000],
    N: [122502, 12976, 3206, 671],              // cascades of S+ posts, original-post roots
    P: [339.8e6, 125.8e6, 60.2e6, 26.2e6],      // posts in them
    Q: [44.8e6, 13.8e6, 4.7e6, 0.9e6],          // posts in quote-rooted cascades of S+ (lower bounds)
    n100: 1568662,                              // cascades of 100+ posts, earlier definition
    band100: 825.9e6 - 449.8e6,                 // posts in cascades of 100 to 999, earlier definition
    window: { 7: 1, 3: 57.6 / 60.2 },           // three days against seven, measured at 10,000+
    months: { September: 1, August: 764.1 / 825.9, July: 709.2 / 825.9, June: 710.3 / 825.9 },
    largest: 400000,
    // the stream-only design it is compared with: day-1 prediction at 10,000+, seven days
    streamOnly: { cascades: 3206, low: 68.7e6, high: 98.6e6 },
    // median share of the seven-day size reached, read off a chart
    growth: { hours: [1, 3, 6, 12, 24, 48, 72], '100 to 999': [0.09, 0.29, 0.48, 0.70, 0.93, 0.99, 1], '1,000 to 9,999': [0.02, 0.15, 0.35, 0.60, 0.89, 0.99, 1], '10,000+': [0.13, 0.30, 0.46, 0.65, 0.86, 0.99, 1] },
    passed10k: { 24: 0.664, 72: 3069 / 3206 },  // share of the cascades of 10,000+ already above 10,000
  };

  function binomSf(h, n, p) {                                // P(Binomial(n,p) >= h)
    if (n < h) return 0;
    if (p >= 1) return 1;
    let pmf = Math.exp(n * Math.log1p(-p)), cdf = pmf; const r = p / (1 - p);
    for (let i = 0; i < h - 1; i++) { pmf *= (n - i) / (i + 1) * r; cdf += pmf; }
    return cdf >= 1 ? 0 : 1 - cdf;
  }

  /* o: { scale: month against September, window: 3 | 7, quoteRooted: count quote-rooted cascades too } */
  function population(o) {
    const k = (o.scale == null ? 1 : o.scale) * (DATA.window[o.window] || 1), D = DATA, last = D.S.length - 1;
    const tail = (D.P[last] / D.N[last]) / (D.P[last] / D.N[last] - D.S[last]);          // power-law exponent above 20,000
    const share = D.P[0] / (D.P[0] + D.Q[0]);
    const curve = (ys, y100, drop) => (s) => {
      s = Math.max(100, s);
      const xs = [100].concat(D.S), v = [y100].concat(ys);
      if (s >= D.S[last]) return ys[last] * Math.pow(s / D.S[last], -drop);
      let i = 0; while (s > xs[i + 1]) i++;
      return v[i] * Math.pow(s / xs[i], Math.log(v[i + 1] / v[i]) / Math.log(xs[i + 1] / xs[i]));
    };
    const n = curve(D.N, D.n100, tail), po = curve(D.P, D.P[0] + D.band100 * share, tail - 1), pq = curve(D.Q, D.Q[0] + D.band100 * (1 - share), tail - 1);
    const N = (s) => (s === Infinity ? 0 : k * n(s));
    const P = (s) => (s === Infinity ? 0 : k * (po(s) + (o.quoteRooted === false ? 0 : pq(s))));
    return { N, P, tail, k, mean: (s) => P(s) / N(s), rough: (s) => s < D.S[0] };
  }

  /* Retweets downloaded when at most M are read from each cascade between lo and hi posts. Cascade counts
     cover original-post roots only, so the sum is scaled to the posts in the band, which include
     quote-rooted cascades (taken to have the same sizes). */
  function firstRetweets(pop, lo, hi, rt, M) {
    const top = Math.min(hi, 2e6); if (!(top > lo)) return 0;
    let acc = 0, raw = 0, a = lo; const steps = 80;
    for (let i = 1; i <= steps; i++) { const b = lo * Math.pow(top / lo, i / steps), w = pop.N(a) - pop.N(b), mid = Math.sqrt(a * b); acc += w * Math.min(rt * mid, M); raw += w * mid; a = b; }
    return raw > 0 ? acc * (pop.P(lo) - pop.P(top)) / raw : 0;
  }

  /* o: { full, rq, census, passes, rt, qt, rtMode: 'none'|'first'|'sample', rtN, rtRate, stream }
     full may be Infinity (no cascade collected in full). */
  function plan(pop, o) {
    const full = o.full, rq = Math.min(o.rq, full), census = Math.min(o.census, rq), rep = 1 - o.rt - o.qt;
    const A = pop.P(full), B = Math.max(0, pop.P(rq) - A);              // posts in tier 1, and in tier 2's band
    const t1 = { replies: rep * A, quotes: o.qt * A, retweets: o.rt * A };
    const bought = o.rtMode === 'first' ? firstRetweets(pop, rq, full, o.rt, o.rtN) : o.rtMode === 'sample' ? (o.rtRate || 0) * o.rt * B : 0;
    const t2 = { replies: rep * B, quotes: o.qt * B, retweets: bought, allRetweets: o.rt * B };
    const roots = pop.N(census), finding = (o.passes || 1) * roots;     // every root at or above the floor, once a pass
    const n1 = pop.N(full), n2 = Math.max(0, pop.N(rq) - n1), n3 = Math.max(0, roots - n1 - n2);
    const cost1 = t1.replies + t1.quotes + t1.retweets, cost2 = t2.replies + t2.quotes, total = cost1 + cost2 + bought + finding;
    return { full, rq, census, A, B, t1, t2, n1, n2, n3, roots, finding, cost1, cost2, bought, total,
             replies: t1.replies + t2.replies, downloaded: cost1 + cost2 + bought, posts: A + B,
             streamRetweets: (o.stream || 0) * t2.allRetweets, censusPosts: Math.max(0, pop.P(census) - A - B) };
  }

  /* Lowest value of `key` ('rq' or 'full') at which the plan costs no more than `budget`; null if none. */
  function lowest(pop, o, key, budget, lo, hi) {
    const cost = (v) => plan(pop, Object.assign({}, o, { [key]: v })).total;
    if (cost(hi) > budget) return null;
    if (cost(lo) <= budget) return lo;
    for (let i = 0; i < 50; i++) { const m = Math.sqrt(lo * hi); if (cost(m) > budget) lo = m; else hi = m; }
    return hi;
  }

  const api = { DATA, population, plan, lowest, firstRetweets, binomSf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CASCADE = api;
})(typeof self !== 'undefined' ? self : globalThis);
