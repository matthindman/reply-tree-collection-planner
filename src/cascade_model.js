/* cascade_model.js — arithmetic for collecting cascades in tiers, on the measured September 2026 population.

   A cascade is the posts sharing one conversation ID (the root and its replies at any depth) plus every
   retweet and quote of those posts. Its size leaves the root out. A quote that is not a reply is a leaf of
   the cascade it quotes and the root of its own.

   The population is CASCADE_TABLES (cascade_tables.js): synthetic cascades of 100+ posts. No row is a real
   cascade. Rows are simulated from summary statistics of groups of at least 100 real cascades in the 30 daily
   summaries from the full Japanese stream, so that counts and post totals by size match the measured ones.
   Each row stands for `w` cascades a month and has a size at 24, 48, 72 and 168 hours, replies and quotes.
   Two things are not in the summaries and come from models fitted to the two days for which every post is on file:
     led         whether the cascade is reply-led (at least half of its retweets hang from replies)
     r0, d0, q0  what the API reports for the root: its own retweets, direct replies and quotes
   A shorter window uses the measured size at that age; replies, quotes and the root's counts are taken to
   have grown in step with the size.

   A plan has three steps, each with its own cost in units (one unit is the charge for one post returned):
     find    search returns every root whose own retweet count or reply count passes a floor, on each pass
     size    for the roots whose counts suggest a cascade near the second tier, read the replies; each reply
             carries its own counts, which gives the size. Replies read for a cascade that turns out too
             small are spent all the same.
     collect every post for cascades of `full`+ posts; replies and quotes for cascades of `rq`+.
   A cascade that search does not return, or that is not sized, is missed. No DOM access. */
(function (root) {
  'use strict';

  const TAB = (typeof CASCADE_TABLES !== 'undefined') ? CASCADE_TABLES : require('./cascade_tables.js');
  const R = TAB.rows, F = TAB.facts, COUNT = R.w.length, KEY = { 1: 's1', 2: 's2', 3: 's3', 7: 's7' };

  const DATA = {
    S: [1000, 5000, 10000, 20000],                 // sizes at which the page prints counts
    months: { September: 1, August: 764.1 / 825.9, July: 709.2 / 825.9, June: 710.3 / 825.9 },   // total volume against September, earlier definition
    largest: F.largest,
    passed10k: F.passed10k,                        // share of the seven-day cascades of 10,000+ that have passed 10,000 by 24, 48, 72 hours
    growth: Object.assign({ hours: F.growth.hours }, F.growth.bands),   // median share of the seven-day size reached
    replyLed: F.reply_led,                         // share of cascades and of posts, and the share of posts day by day
    main: F.main, quote: F.quote,                  // cascades of 100+ and their posts, seven days: original-post roots, quote roots
    rule: F.rule,                                  // size from a root's counts
    // the stream-only design: a day-1 rule for cascades that will pass 10,000 in seven days
    streamOnly: { cascades: 3206, posts: 60.2e6, low: 68.7e6, high: 98.6e6 },
  };

  /* Prize draws ("follow and repost to win"). The daily summaries have no text, so which cascades are prize draws comes
     from a topic study of 3,974 sampled roots for September 2026. `p` is the prize draws' share of posts among cascades
     that are not reply-led, by size at three days (lower edges in `size`); `quote` is their share of cascades rooted at
     a quote, by size. A synthetic cascade is split into a prize-draw part and a remainder by its size's share, so the
     posts in prize draws add up to the measured share at every size. */
  const PRIZE = {
    size: [0, 100, 300, 850, 2000, 3500, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 100000],
    p: [0.0277, 0.0184, 0.04, 0.0751, 0.1054, 0.1408, 0.2126, 0.4008, 0.4514, 0.5675, 0.6807, 0.7417, 0.8141, 1],
    quote: { size: [0, 1000, 10000], p: [0.011, 0.0213, 0.0306] },
  };
  DATA.prize = PRIZE;
  /* Measured on the two days with every post on file (roots of 2 and 3 September 2026), with floors of 300 retweets or
     100 replies read at 72 hours. returned: the share of all reply-led cascades of 100+ that search returns.
     caught: of the reply-led roots returned, the share the count rule reads as reply-led. falseFlag: of the other roots
     returned, the share it wrongly reads as reply-led. */
  DATA.recognition = { returned: [0.248, 0.251], returned300to999: 0.259, returned1000to2999: [0.81, 0.88], caught: [0.83, 0.80], falseFlag: [0.043, 0.046] };
  const bin = (edges, v) => { let i = edges.length - 1; while (i > 0 && v < edges[i]) i--; return i; };
  function prizeShare(i) {                                   // row i of the table: the share of it that is prize draws
    if (R.led[i]) return 0;
    return R.q[i] ? PRIZE.quote.p[bin(PRIZE.quote.size, R.s7[i])] : PRIZE.p[bin(PRIZE.size, R.s3[i])];
  }

  function binomSf(h, n, p) {                                // P(Binomial(n,p) >= h)
    if (h <= 0) return 1;
    if (n < h) return 0;
    if (p >= 1) return 1;
    let pmf = Math.exp(n * Math.log1p(-p)), cdf = pmf; const r = p / (1 - p);
    for (let i = 0; i < h - 1; i++) { pmf *= (n - i) / (i + 1) * r; cdf += pmf; }
    return cdf >= 1 ? 0 : 1 - cdf;
  }

  // size of a cascade as read from its root's counts alone
  function fromCounts(r0, d0, q0) {
    const own = r0 + d0 + q0, k = DATA.rule;
    return d0 > k.ratio * r0 ? own + k.kB * d0 : k.kA * own;
  }

  /* rows: [{ w, s, q, led, rep, qt, r0, d0, q0 }] at one window. Sorted by size, largest first, with running
     totals, so counts and posts at or above a size are one lookup. o.replyLed === false (or 0) leaves the reply-led
     cascades out of every count: they are not wanted and are not collected. A row marked `out` is the part of a
     reply-led or prize-draw group that is left out; it is treated the same way. A row marked `prize` is a prize draw. */
  function build(rows, o) {
    rows = rows.slice().sort((a, b) => b.s - a.s);
    const wantLed = !o || (o.replyLed !== false && o.replyLed !== 0), n = rows.length;
    const cN = new Float64Array(n + 1), cQ = new Float64Array(n + 1), cP = new Float64Array(n + 1), cPO = new Float64Array(n + 1), cRep = new Float64Array(n + 1), cQt = new Float64Array(n + 1), cLed = new Float64Array(n + 1), cPrize = new Float64Array(n + 1);
    rows.forEach((r, i) => {
      r.skip = !!(r.out || (r.led && !wantLed));
      const w = r.skip ? 0 : r.w;
      cN[i + 1] = cN[i] + (r.q ? 0 : w); cQ[i + 1] = cQ[i] + (r.q ? w : 0);
      cP[i + 1] = cP[i] + w * r.s; cPO[i + 1] = cPO[i] + (r.q ? 0 : w * r.s);
      cRep[i + 1] = cRep[i] + w * r.rep; cQt[i + 1] = cQt[i] + w * r.qt; cLed[i + 1] = cLed[i] + (r.led ? w * r.s : 0); cPrize[i + 1] = cPrize[i] + (r.prize ? w * r.s : 0);
    });
    const upto = (s) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].s >= s) lo = m + 1; else hi = m; } return lo; };   // rows of at least s posts
    const at = (c) => (s) => c[upto(s)];
    const pop = { rows, N: at(cN), NQ: at(cQ), P: at(cP), PO: at(cPO), Rep: at(cRep), Qt: at(cQt), LedPosts: at(cLed), PrizePosts: at(cPrize) };
    pop.NA = (s) => pop.N(s) + pop.NQ(s);
    pop.RQ = (s) => pop.Rep(s) + pop.Qt(s);
    pop.mean = (s) => pop.P(s) / pop.NA(s);
    return pop;
  }

  /* o: { scale: volume against September, window: 1 | 2 | 3 | 7 days, quoteRooted: count quote-rooted cascades too,
          replyLed: count reply-led cascades too. true or 1: all of them. false or 0: none. A share between 0 and 1:
                    a random sample of that share, drawn by root before anything is read; the rest are returned by
                    search, recognised and not collected.
          prize: the same for prize draws (default 1, all of them). A prize draw is recognised from the root's text,
                 which search returns, so one that is left out costs nothing more: its replies are not read. }
     N: cascades rooted at an original post. NQ: rooted at a quote. NA: both. P: posts in both. PO: posts in the
     first kind. Rep, Qt, RQ: replies, quotes, and both, in cascades of at least that size. */
  let PZ = null;
  function population(o) {
    o = o || {};
    if (!PZ) { PZ = new Float64Array(COUNT); for (let i = 0; i < COUNT; i++) PZ[i] = prizeShare(i); }
    const key = KEY[o.window] || 's7', sc = o.scale == null ? 1 : o.scale, rows = [];
    const share = o.replyLed === false ? 0 : (o.replyLed == null || o.replyLed === true) ? 1 : Math.min(1, Math.max(0, +o.replyLed));
    const prize = o.prize === false ? 0 : (o.prize == null || o.prize === true) ? 1 : Math.min(1, Math.max(0, +o.prize));
    for (let i = 0; i < COUNT; i++) {
      if (o.quoteRooted === false && R.q[i]) continue;
      const s = R[key][i], f = s / R.s7[i];
      if (!(s > 0)) continue;
      const row = (w, out, pr) => ({ w, out, prize: pr || 0, s, q: R.q[i], led: R.led[i], rep: R.rep[i] * f, qt: R.qt[i] * f, r0: R.r0[i] * f, d0: R.d0[i] * f, q0: R.q0[i] * f });
      const w = R.w[i] * sc, put = (wt, out, pr) => { if (wt > 0) rows.push(row(wt, out, pr)); };
      if (R.led[i]) { if (share > 0 && share < 1) { put(w * share, 0); put(w * (1 - share), 1); } else put(w, 0); continue; }
      const pz = PZ[i];
      put(w * (1 - pz), 0); put(w * pz * prize, 0, 1); put(w * pz * (1 - prize), 1, 1);
    }
    const pop = build(rows, Object.assign({}, o, { replyLed: share > 0 }));
    pop.ledShare = share; pop.prizeShare = prize;
    // what the window keeps: posts of the seven-day cascades of 100+, and how many of the 10,000+ still reach 10,000
    let p7 = 0, pw = 0; for (let i = 0; i < COUNT; i++) { if (o.quoteRooted === false && R.q[i]) continue; p7 += R.w[i] * R.s7[i]; pw += R.w[i] * R[key][i]; }
    pop.share = pw / p7; pop.window = o.window || 7;
    return pop;
  }

  /* o: { full, rq, passes, fr, fd, triage: 'counts' | 'stream' | 'all', theta, rtMode: 'none'|'first'|'sample', rtN, rtRate, stream,
          found: 'search' (default) or 'all' (every cascade is taken as found and sized at no cost) }
     fr, fd: floors on the root's own retweets and replies; a root passing either is returned on every pass.
     triage: which returned roots have their replies read. 'counts': those whose size read from the root's counts
     is at least theta * rq. 'stream': those with enough posts in the 1% sample to suggest theta * rq. 'all': every one.
     full may be Infinity (no cascade collected in full). n1, n2 count cascades rooted at an original post;
     q1, q2 those rooted at a quote.
     When the population holds a sample of the reply-led cascades (pop.ledShare between 0 and 1), the sample is drawn
     by root before anything is read, so a root that search returns through the floor on replies alone has its
     replies read only if it is in the sample. Search still returns, and charges for, every such root.
     recog: how a returned root is known to be reply-led before its replies are read.
       'class' (the default, and the page's assumption until 24 November 2026): always, at no cost.
       'counts': from the root's own counts, by the rule used for sizing: more than DATA.rule.ratio replies for each
         retweet. Two kinds of error follow. A reply-led root that does not look it and passes the floor on retweets
         has its replies read like any other; the read shows what it is, and it is then kept only if it is in the
         sample, so the part left out costs its replies (strayUnits, counted in waste). A root that is not reply-led
         but looks it is set aside unread unless it is in the sample (lost: wanted cascades given up this way).
         One draw is made for each root: a prize draw that is kept is read whichever floor returned it. */
  function plan(pop, o) {
    const full = o.full, rq = Math.min(o.rq, full), all = o.found === 'all', passes = o.passes == null ? 1 : o.passes;
    const fr = o.fr == null ? Infinity : o.fr, fd = o.fd == null ? Infinity : o.fd, theta = o.theta == null ? 0.5 : o.theta, need = theta * rq;
    const hits = Math.max(1, Math.ceil(need * (o.stream || 0.01))), triage = o.triage || 'counts';
    const viaShare = pop.ledShare > 0 && pop.ledShare < 1 ? pop.ledShare : 1, byCounts = o.recog === 'counts' && !all;
    const flagShare = pop.ledShare == null ? 1 : pop.ledShare;   // the share of roots that look reply-led whose replies are read
    const t1 = { replies: 0, quotes: 0, retweets: 0 }, t2 = { replies: 0, quotes: 0, retweets: 0, allRetweets: 0 };
    let roots = 0, sized = 0, waste = 0, n1 = 0, n2 = 0, q1 = 0, q2 = 0, A = 0, B = 0, want1 = 0, want2 = 0, gotA = 0, gotB = 0, bought = 0, stray = 0, strayUnits = 0, lost = 0;
    const read = (r) => (all || triage === 'all' ? 1 : triage === 'stream' ? binomSf(hits, Math.round(r.s), o.stream || 0.01) : (fromCounts(r.r0, r.d0, r.q0) >= need ? 1 : 0));
    for (const r of pop.rows) {
      const cand = all ? r.s >= rq : (r.r0 >= fr || r.d0 >= fd);
      if (!all && cand) roots += r.w;
      if (r.skip) {                                            // returned by search, recognised, not collected
        // by counts, a reply-led root that passes the floor on retweets and does not look reply-led is read before it is dropped
        if (byCounts && r.led && r.r0 >= fr && !looksLed(r)) { const pv = read(r); stray += r.w * pv; strayUnits += r.w * pv * r.rep; }
        continue;
      }
      const tier = r.s >= full ? 1 : r.s >= rq ? 2 : 0, rt = r.s - r.rep - r.qt;
      if (tier === 1) { A += r.w * r.s; want1 += r.w; } else if (tier === 2) { B += r.w * r.s; want2 += r.w; }
      if (!cand) continue;
      const pv = read(r);
      if (!(pv > 0)) continue;
      const coin = coinOf(r, o, fr, all, viaShare, flagShare);
      if (tier && coin < 1) lost += r.w * pv * (1 - coin) * (byCounts && r.r0 >= fr ? 1 : 0);
      const w = r.w * pv * coin;
      sized += w;
      if (tier === 1) { t1.replies += w * r.rep; t1.quotes += w * r.qt; t1.retweets += w * rt; gotA += w * r.s; if (r.q) q1 += w; else n1 += w; }
      else if (tier === 2) {
        t2.replies += w * r.rep; t2.quotes += w * r.qt; t2.allRetweets += w * rt; gotB += w * r.s; if (r.q) q2 += w; else n2 += w;
        bought += o.rtMode === 'first' ? w * Math.min(rt, o.rtN) : o.rtMode === 'sample' ? w * (o.rtRate || 0) * rt : 0;
      } else if (!all) waste += w * r.rep;
    }
    t2.retweets = bought; waste += strayUnits;
    const finding = passes * roots, cost1 = t1.replies + t1.quotes + t1.retweets, cost2 = t2.replies + t2.quotes, total = cost1 + cost2 + bought + waste + finding;
    return { full, rq, A, B, t1, t2, n1, n2, q1, q2, roots, finding, sized, waste, cost1, cost2, bought, total,
             want1, want2, found1: want1 ? (n1 + q1) / want1 : 1, found2: want2 ? (n2 + q2) / want2 : 1,
             found: want1 + want2 ? (n1 + q1 + n2 + q2) / (want1 + want2) : 1, foundPosts: A + B ? (gotA + gotB) / (A + B) : 1,
             replies: t1.replies + t2.replies, downloaded: cost1 + cost2 + bought, posts: gotA + gotB, wanted: A + B,
             streamRetweets: (o.stream || 0) * t2.allRetweets, stray, strayUnits, lost };
  }

  // a root that looks reply-led from its own counts: the rule that sizes it
  const looksLed = (r) => r.d0 > DATA.rule.ratio * r.r0;
  /* The share of a returned, wanted row whose replies are read. Rows of a sampled class already carry their share.
     'class': an ordinary root found by its replies alone is read only if sampled (and so, as the page had it, is a kept
     prize draw found that way). 'counts': one draw for each root, so a kept prize draw is always read, and an ordinary
     root is read only if sampled when it was found by its replies alone or looks reply-led. */
  function coinOf(r, o, fr, all, viaShare, flagShare) {
    if (all || r.led) return 1;
    const viaReply = !(r.r0 >= fr);
    if (o.recog !== 'counts') return viaReply ? viaShare : 1;
    if (r.prize) return 1;
    return viaReply ? viaShare : looksLed(r) ? flagShare : 1;
  }

  /* Share of cascades found and sized, by size: [{ lo, hi, n, found }] over bands of the population. */
  function foundBySize(pop, o, edges) {
    const out = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0, got: 0 }));
    const need = (o.theta == null ? 0.5 : o.theta) * Math.min(o.rq, o.full), hits = Math.max(1, Math.ceil(need * (o.stream || 0.01)));
    const viaShare = pop.ledShare > 0 && pop.ledShare < 1 ? pop.ledShare : 1, flagShare = pop.ledShare == null ? 1 : pop.ledShare;
    for (const r of pop.rows) {
      const b = out.find((x) => r.s >= x.lo && r.s < x.hi); if (!b) continue;
      const cand = r.r0 >= o.fr || r.d0 >= o.fd;
      if (r.led) { b.ledN = (b.ledN || 0) + r.w; b.ledCand = (b.ledCand || 0) + (cand ? r.w : 0); }   // the whole class, kept or not
      if (r.skip) continue;
      const pv = !cand ? 0 : o.triage === 'all' ? 1 : o.triage === 'stream' ? binomSf(hits, Math.round(r.s), o.stream || 0.01) : (fromCounts(r.r0, r.d0, r.q0) >= need ? 1 : 0);
      b.n += r.w; b.got += r.w * pv * coinOf(r, o, o.fr, false, viaShare, flagShare); b.cand = (b.cand || 0) + (cand ? r.w : 0);
    }
    return out.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, found: b.n ? b.got / b.n : null, returned: b.n ? (b.cand || 0) / b.n : null,
                             ledN: b.ledN || 0, ledReturned: b.ledN ? (b.ledCand || 0) / b.ledN : null }));
  }

  /* How much of a class that is sampled the sample can stand for. The sample is drawn from the roots search returns, so a
     cascade that no floor returns has no chance of being in it. kind: 'led' (reply-led cascades) or 'prize' (prize draws).
     For each size band [{ lo, hi, n, returned, read }]: n cascades of the class a month, kept or not; the share search
     returns; the share whose replies would be read if drawn (returned and likely enough by the triage rule). A sampled
     cascade stands for 1 / share of the returned ones, not of the class. */
  function reach(pop, o, kind, edges) {
    const out = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0, ret: 0, rd: 0 }));
    const need = (o.theta == null ? 0.5 : o.theta) * Math.min(o.rq, o.full), hits = Math.max(1, Math.ceil(need * (o.stream || 0.01)));
    const fr = o.fr == null ? Infinity : o.fr, fd = o.fd == null ? Infinity : o.fd;
    for (const r of pop.rows) {
      if (kind === 'led' ? !r.led : !r.prize) continue;
      const b = out.find((x) => r.s >= x.lo && r.s < x.hi); if (!b) continue;
      const cand = r.r0 >= fr || r.d0 >= fd;
      const pv = !cand ? 0 : o.triage === 'all' ? 1 : o.triage === 'stream' ? binomSf(hits, Math.round(r.s), o.stream || 0.01) : (fromCounts(r.r0, r.d0, r.q0) >= need ? 1 : 0);
      b.n += r.w; b.ret += cand ? r.w : 0; b.rd += r.w * pv;
    }
    return out.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, returned: b.n ? b.ret / b.n : null, read: b.n ? b.rd / b.n : null }));
  }

  /* Lowest value of `key` ('rq' or 'full') between lo and hi at which the plan costs no more than `budget`.
     null if none does, or if the budget is not a positive number. An open upper limit means the largest cascade. */
  function lowest(pop, o, key, budget, lo, hi) {
    if (!(budget > 0) || !(lo > 0)) return null;
    const top = (pop.rows.length ? pop.rows[0].s : 1) + 1;
    if (!(hi < top)) hi = top;
    const cost = (v) => plan(pop, Object.assign({}, o, { [key]: v })).total;
    if (cost(hi) > budget) return null;
    if (cost(lo) <= budget) return lo;
    for (let i = 0; i < 40; i++) { const m = Math.sqrt(lo * hi); if (cost(m) > budget) lo = m; else hi = m; }
    return hi;
  }

  const api = { DATA, TABLES: TAB, population, build, plan, lowest, foundBySize, reach, fromCounts, binomSf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CASCADE = api;
})(typeof self !== 'undefined' ? self : globalThis);
