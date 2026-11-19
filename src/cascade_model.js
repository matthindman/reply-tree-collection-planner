/* cascade_model.js — arithmetic for collecting cascades (a root with its replies, quotes and retweets).

   Inputs are monthly totals for cascades of 1,000+ posts within the observation window:
     n1000   cascades of 1,000+ posts
     p1000   posts in them, quotes excluded (roots, replies and retweets)
     q1000   quotes of them
     rt      share of those posts that are retweets
     nAll    a second count of cascades, used only to report the size floor it corresponds to
   Sizes above 1,000 follow a Pareto tail whose exponent is set by the mean size, so
     cascades of s+ posts  = n1000 (s/1000)^(-a)
     posts in them         = p1000 (s/1000)^(1-a)
   The mix of retweets, replies and quotes is taken to be the same at every size.
   Costs are in units: one unit is the charge for one post returned. No DOM access. */
(function (root) {
  'use strict';

  function binomSf(h, n, p) {                                // P(Binomial(n,p) >= h)
    if (n < h) return 0;
    if (p >= 1) return 1;
    let pmf = Math.exp(n * Math.log1p(-p)), cdf = pmf; const r = p / (1 - p);
    for (let i = 0; i < h - 1; i++) { pmf *= (n - i) / (i + 1) * r; cdf += pmf; }
    return cdf >= 1 ? 0 : 1 - cdf;
  }

  function population(inp) {
    const mean = inp.p1000 / inp.n1000;
    const a = Math.min(8, Math.max(1.02, mean / Math.max(1e-9, mean - 1000)));
    const N = (s) => inp.n1000 * Math.pow(s / 1000, -a);
    const P = (s) => inp.p1000 * Math.pow(s / 1000, 1 - a);
    const Q = (s) => inp.q1000 * Math.pow(s / 1000, 1 - a);
    /* Retweets downloaded when at most M are read from any one cascade: N(s) * E[min(rt*S, M) | S >= s]. */
    const rtFirst = (s, M) => {
      const m = M / inp.rt;
      if (m <= s) return N(s) * M;
      return N(s) * inp.rt * (a / (a - 1) * s - Math.pow(s, a) * Math.pow(m, 1 - a) / (a - 1));
    };
    return { a, mean, rt: inp.rt, N, P, Q, rtFirst, floorOfAll: 1000 * Math.pow(inp.n1000 / inp.nAll, 1 / a) };
  }

  /* Share of cascades of s+ posts that a sample of rate p flags, when h sampled posts are needed. */
  function flagged(pop, s, p, h) {
    if (!(p > 0)) return 0;
    let acc = 0, lo = s; const steps = 240, top = s * 1e4;
    for (let i = 1; i <= steps; i++) {
      const hi = s * Math.pow(top / s, i / steps), mid = Math.sqrt(lo * hi);
      acc += (pop.N(lo) - pop.N(hi)) * binomSf(h, Math.round(mid), p); lo = hi;
    }
    return (acc + pop.N(top)) / pop.N(s);
  }

  /* One plan at one size cutoff.
     o: { cut, quotes, under, rtMode: 'none'|'first'|'all', rtN, rtShare, days,
          stream: 0 | rate, streamInCap, streamVolume, hits } */
  function plan(pop, o) {
    const s = o.cut, found = o.stream > 0 ? flagged(pop, s, o.stream, o.hits || 1) : 1;
    const cascades = pop.N(s) * found;
    const replies = (1 - pop.rt) * pop.P(s) * found;                       // roots included
    const quotes = o.quotes ? pop.Q(s) * found : 0, under = o.quotes ? quotes * (o.under || 0) : 0;
    const allRt = pop.rt * pop.P(s) * found;
    const retweets = o.rtMode === 'all' ? allRt * o.rtShare : o.rtMode === 'first' ? pop.rtFirst(s, o.rtN) * found * o.rtShare : 0;
    const watched = pop.N(s / 2);                                          // cascades whose counts are looked up daily
    const checks = o.days * watched;
    const finding = o.stream > 0 ? (o.streamInCap ? o.streamVolume : 0) : o.days * watched;   // no stream: search roots by repost count
    const total = replies + quotes + under + retweets + checks + finding;
    const allPosts = (pop.P(s) + pop.Q(s)) * found;
    return { cut: s, found, cascades, replies, quotes, under, retweets, checks, finding, total, watched,
             allRt, allPosts, downloaded: replies + quotes + retweets, sampledRt: o.stream > 0 ? o.stream * allRt : 0 };
  }

  /* Smallest cutoff at which the plan fits the cap. */
  function reach(pop, o, cap) {
    for (let i = 0; i <= 300; i++) {
      const cut = 100 * Math.pow(10, i / 75);                              // 100 to 1,000,000 in fine log steps
      if (plan(pop, Object.assign({}, o, { cut })).total <= cap) return cut;
    }
    return null;
  }

  const api = { population, plan, reach, flagged, binomSf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CASCADE = api;
})(typeof self !== 'undefined' ? self : globalThis);
