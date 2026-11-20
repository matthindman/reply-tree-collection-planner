/* cascade_model.js — arithmetic for collecting cascades in tiers, on measured size tables.

   A cascade is the posts sharing one conversation ID (the root and its replies at any depth) plus every
   retweet and quote of those posts. Its size leaves the root out. A quote that is not a reply is a leaf of
   the cascade it quotes and the root of its own.

   DATA holds counts for September 2026 from the full Japanese stream (seven-day window). The model is one
   size distribution: between two measured sizes the count of cascades is a smooth curve on log-log axes,
   bent so that the posts it implies equal the posts measured in that band. Posts are then summed from the
   counts, so the two agree. No cascade is taken to pass 100 million posts.

   A shorter window shrinks every cascade by one factor. The factor is set so that the number of cascades
   of 10,000+ posts matches the count for that window: measured for three days and for one day, estimated
   for two. For three days this reproduces the measured posts (57.5M against 57.6M). Above 20,000 posts the counts follow a power law set by the mean size
   there. Below 1,000 only one count exists, made under an earlier definition, so everything below 1,000
   is rough.

   Counts were measured for cascades rooted at an original post. For cascades rooted at a quote only posts
   are known (lower bounds). Their number is estimated by taking them to have the same sizes, band by band.

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
    // keep: share of the seven-day cascades of 10,000+ whose size has passed 10,000 by the end of the window.
    // Measured for three days (3,069 of 3,206) and one day; two days is an estimate between them.
    // One and two days are rough: the post totals for them were not measured.
    window: { 7: { keep: 1 }, 3: { keep: 3069 / 3206 }, 2: { keep: 0.91, rough: true }, 1: { keep: 0.664, rough: true } },
    months: { September: 1, August: 764.1 / 825.9, July: 709.2 / 825.9, June: 710.3 / 825.9 },
    largest: 400000,
    // the stream-only design: a day-1 rule for cascades that will pass 10,000 in seven days, original-post
    // roots. It finds most of them and downloads this many posts, wrong guesses included.
    streamOnly: { cascades: 3206, posts: 60.2e6, low: 68.7e6, high: 98.6e6 },
    // median share of the seven-day size reached, read off a chart
    growth: { hours: [1, 3, 6, 12, 24, 48], '100 to 999': [0.09, 0.29, 0.48, 0.70, 0.93, 0.99], '1,000 to 9,999': [0.02, 0.15, 0.35, 0.60, 0.89, 0.99], '10,000+': [0.13, 0.30, 0.46, 0.65, 0.86, 0.99] },
    passed10k: { 24: 0.664, 72: 3069 / 3206 },  // share of the seven-day cascades of 10,000+ whose total size had passed 10,000
  };

  function binomSf(h, n, p) {                                // P(Binomial(n,p) >= h)
    if (h <= 0) return 1;
    if (n < h) return 0;
    if (p >= 1) return 1;
    let pmf = Math.exp(n * Math.log1p(-p)), cdf = pmf; const r = p / (1 - p);
    for (let i = 0; i < h - 1; i++) { pmf *= (n - i) / (i + 1) * r; cdf += pmf; }
    return cdf >= 1 ? 0 : 1 - cdf;
  }

  /* The September, seven-day distribution, built once. Band j runs from xs[j] to xs[j+1]. In it
     ln N(u) = ln N_j - L u + c u (1 - u), u the position on a log scale, L = ln(N_j / N_j+1). The bend c
     is solved so the posts in the band equal the measured posts; |c| < L keeps the count falling. */
  const G = 240, TOP = 1e8;                                   // TOP: no cascade is taken to be this large
  const BASE = (function () {
    const D = DATA, last = D.S.length - 1, share = D.P[0] / (D.P[0] + D.Q[0]);
    const xs = [100].concat(D.S), n = [D.n100].concat(D.N);
    const posts = [D.band100 * share], quote = [D.band100 * (1 - share)];
    for (let i = 0; i < last; i++) { posts.push(D.P[i] - D.P[i + 1]); quote.push(D.Q[i] - D.Q[i + 1]); }
    const tail = (D.P[last] / D.N[last]) / (D.P[last] / D.N[last] - D.S[last]);        // power-law exponent above 20,000
    const bands = posts.map((target, j) => {
      const a = xs[j], b = xs[j + 1], L = Math.log(n[j] / n[j + 1]), R = Math.log(b / a);
      const count = (c, u) => n[j] * Math.exp(-L * u + c * u * (1 - u)), size = (u) => a * Math.exp(R * u);
      const sum = (c) => { let t = 0; for (let k = 0; k < G; k++) t += (count(c, k / G) - count(c, (k + 1) / G)) * Math.sqrt(size(k / G) * size((k + 1) / G)); return t; };
      let lo = -0.98 * L, hi = 0.98 * L;
      for (let i = 0; i < 70; i++) { const m = (lo + hi) / 2; if (sum(m) < target) lo = m; else hi = m; }
      const c = (lo + hi) / 2, T = new Array(G + 1); T[G] = 0;                        // T[k]: posts from grid point k to the band's top
      for (let k = G - 1; k >= 0; k--) T[k] = T[k + 1] + (count(c, k / G) - count(c, (k + 1) / G)) * Math.sqrt(size(k / G) * size((k + 1) / G));
      return { a, b, R, c, L, T, count: (u) => count(c, u), size, q: quote[j] / target, fitted: T[0], target };
    });
    const qTail = D.Q[last] / D.P[last], top = D.S[last];
    const nqAt = new Array(xs.length); nqAt[last + 1] = qTail * D.N[last];             // quote-rooted cascades at each measured size
    for (let j = last; j >= 0; j--) nqAt[j] = nqAt[j + 1] + bands[j].q * (n[j] - n[j + 1]);
    const find = (s) => { let j = 0; while (j < bands.length - 1 && s >= bands[j].b) j++; return j; };
    // each returns [original-root value, quote-rooted value]
    function N(s) {
      if (s >= top) { const v = D.N[last] * Math.pow(s / top, -tail); return [v, qTail * v]; }
      const j = find(s), B = bands[j], v = B.count(Math.log(s / B.a) / B.R);
      return [v, nqAt[j + 1] + B.q * (v - n[j + 1])];
    }
    function P(s) {
      if (s >= top) { const v = D.P[last] * Math.pow(s / top, 1 - tail); return [v, qTail * v]; }
      const j = find(s), B = bands[j], u = Math.log(s / B.a) / B.R, k = Math.min(G - 1, Math.floor(u * G));
      const inBand = B.T[k + 1] + (B.count(u) - B.count((k + 1) / G)) * Math.sqrt(s * B.size((k + 1) / G));
      return [D.P[j] + inBand, D.Q[j] + B.q * inBand];
    }
    // the factor by which a window shrinks every cascade, so that keep * N(10,000) cascades still reach 10,000
    const memo = {};
    function shrink(keep) {
      if (!(keep < 1)) return 1;
      if (memo[keep]) return memo[keep];
      let lo = 0.2, hi = 1; const want = keep * D.N[2];
      for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (N(D.S[2] / m)[0] < want) lo = m; else hi = m; }
      return (memo[keep] = (lo + hi) / 2);
    }
    return { N, P, tail, bands, shrink };
  })();

  /* o: { scale: volume against September, window: 1 | 2 | 3 | 7 days, quoteRooted: count quote-rooted cascades too }
     N: cascades rooted at an original post (measured). NQ: cascades rooted at a quote (estimated).
     NA: both. P: posts in both. PO: posts in the first kind only. */
  function population(o) {
    const w = DATA.window[o.window] || DATA.window[7], g = BASE.shrink(w.keep), sc = o.scale == null ? 1 : o.scale, q = o.quoteRooted === false ? 0 : 1;
    // a cascade of s posts in this window is one of s / g posts in seven days
    const at = (f, k) => (s) => { const x = Math.max(100, s) / g; return x < TOP ? f(x).map((v) => k * v) : [0, 0]; };
    const n = at(BASE.N, sc), p = at(BASE.P, sc * g);
    const N = (s) => n(s)[0], NQ = (s) => q * n(s)[1], NA = (s) => N(s) + NQ(s), PO = (s) => p(s)[0], P = (s) => PO(s) + q * p(s)[1];
    return { N, NQ, NA, P, PO, tail: BASE.tail, shrink: g, windowRough: !!w.rough, mean: (s) => P(s) / NA(s), rough: (s) => s < DATA.S[0] };
  }

  /* Retweets downloaded when at most M are read from each cascade between lo and hi posts. Each step uses
     the mean size of the cascades in it, so with M above every size the result is every retweet. */
  function firstRetweets(pop, lo, hi, rt, M) {
    const top = hi < TOP ? hi : TOP; if (!(top > lo)) return 0;
    let acc = 0, a = lo; const steps = 200;
    for (let i = 1; i <= steps; i++) { const b = lo * Math.pow(top / lo, i / steps), w = pop.NA(a) - pop.NA(b); if (w > 0) acc += w * Math.min(rt * (pop.P(a) - pop.P(b)) / w, M); a = b; }
    return acc;
  }

  /* o: { full, rq, census, passes, rt, qt, rtMode: 'none'|'first'|'sample', rtN, rtRate, stream }
     full may be Infinity (no cascade collected in full). passes may be 0 (no search by counts).
     A cascade in the second tier has to be found, so the census floor is never above rq.
     n1, n2, n3 count cascades rooted at an original post; q1, q2, q3 are the estimated quote-rooted ones. */
  function plan(pop, o) {
    const full = o.full, rq = Math.min(o.rq, full), census = Math.min(o.census, rq), rep = 1 - o.rt - o.qt;
    const A = pop.P(full), B = Math.max(0, pop.P(rq) - A);              // posts in tier 1, and in tier 2's band
    const t1 = { replies: rep * A, quotes: o.qt * A, retweets: o.rt * A };
    const bought = o.rtMode === 'first' ? firstRetweets(pop, rq, full, o.rt, o.rtN) : o.rtMode === 'sample' ? (o.rtRate || 0) * o.rt * B : 0;
    const t2 = { replies: rep * B, quotes: o.qt * B, retweets: bought, allRetweets: o.rt * B };
    const roots = pop.NA(census), finding = (o.passes == null ? 1 : o.passes) * roots;   // every root at or above the floor, once a pass
    const n1 = pop.N(full), n2 = Math.max(0, pop.N(rq) - n1), n3 = Math.max(0, pop.N(census) - n1 - n2);
    const q1 = pop.NQ(full), q2 = Math.max(0, pop.NQ(rq) - q1), q3 = Math.max(0, pop.NQ(census) - q1 - q2);
    const cost1 = t1.replies + t1.quotes + t1.retweets, cost2 = t2.replies + t2.quotes, total = cost1 + cost2 + bought + finding;
    return { full, rq, census, A, B, t1, t2, n1, n2, n3, q1, q2, q3, roots, finding, cost1, cost2, bought, total,
             replies: t1.replies + t2.replies, downloaded: cost1 + cost2 + bought, posts: A + B,
             streamRetweets: (o.stream || 0) * t2.allRetweets, censusPosts: Math.max(0, pop.P(census) - A - B) };
  }

  /* Lowest value of `key` ('rq' or 'full') between lo and hi at which the plan costs no more than `budget`.
     null if none does, or if the budget is not a positive number. An open upper limit means 100 million posts. */
  function lowest(pop, o, key, budget, lo, hi) {
    if (!(budget > 0) || !(lo > 0)) return null;
    if (!(hi < TOP)) hi = TOP;
    const cost = (v) => plan(pop, Object.assign({}, o, { [key]: v })).total;
    if (cost(hi) > budget) return null;
    if (cost(lo) <= budget) return lo;
    for (let i = 0; i < 60; i++) { const m = Math.sqrt(lo * hi); if (cost(m) > budget) lo = m; else hi = m; }
    return hi;
  }

  const api = { DATA, BASE, population, plan, lowest, firstRetweets, binomSf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CASCADE = api;
})(typeof self !== 'undefined' ? self : globalThis);
