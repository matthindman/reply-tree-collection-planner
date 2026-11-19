/* cost.js — what each way of collecting costs and finds, for a population table.

   Costs are in units per reply in the population. One unit is the charge for one post returned, so 1.0 is the
   charge for reading every reply once. Count requests, request fees and other charges are converted to units
   at the prices passed in; whether they draw on a post quota is a contract question the caller answers through
   those prices.

   Ways of finding conversations:
     root    search for roots with at least T replies (min_replies:T), then fetch
     sample  a random share p of replies; a conversation becomes a candidate at its h-th sampled reply
     both    root search, plus a sample for the conversations root search cannot see
   A candidate is either counted once (and fetched only if it reaches the cutoff) or fetched outright.
   Any plan can also admit only a random share of its candidates; that is how a plan is fitted to a budget.
   The search is over this family of plans, not over every conceivable plan.
   Static model: a conversation is judged on its final size. No DOM access. */
(function (root) {
  'use strict';
  const G = (typeof module !== 'undefined' && module.exports) ? require('./sim.js') : root.GRT;
  const E = G.EDGES, NB = G.NB;

  const P_GRID = (() => { const a = []; for (let i = 0; i <= 120; i++) a.push(Math.pow(10, -4 + i / 30)); a[120] = 1; return a; })();
  const H_GRID = [1, 2, 3, 5, 10, 20, 50, 100];
  const T_BOTH = E.filter((e) => e >= 2 && e <= 5000);      // root thresholds tried in the combined strategy
  const MIN_CUT = 20;
  const kMid = (k) => (k < 20 ? E[k] : Math.sqrt(E[k] * ((k + 1 < NB ? E[k + 1] : 2 * E[k]) - 1)));

  function binomSf(h, n, p) {                                // P(Binomial(n,p) >= h)
    if (n < h) return 0;
    if (p >= 1) return 1;
    let pmf = Math.exp(n * Math.log1p(-p)), cdf = pmf; const r = p / (1 - p);
    for (let i = 0; i < h - 1; i++) { pmf *= (n - i) / (i + 1) * r; cdf += pmf; }
    return cdf >= 1 ? 0 : 1 - cdf;
  }

  /* pop: {w, ws, wq} per reply by cell (size bin i, root-reply bin k): conversations, posts, and quiet-root
     conversations (fewer than half the replies answer the root). If wq is missing, a cell is classed by its
     mean size and the middle of its root-reply bin.
     opts.cap: read at most this many posts of any conversation (Infinity = complete).
     opts.descendants: min_replies counts all replies in the conversation, not direct replies. */
  function buildPop(w, ws, opts) {
    opts = opts || {};
    const cap = opts.cap || Infinity, wq = opts.wq || null;
    const Wi = new Float64Array(NB), Si = new Float64Array(NB), Pi = new Float64Array(NB), Gi = new Float64Array(NB);
    const cumW = new Float64Array(NB * (NB + 1)), cumP = new Float64Array(NB * (NB + 1)), cumG = new Float64Array(NB * (NB + 1));
    const quietW = new Float64Array(NB), chainW = new Float64Array(NB), kOf = new Int16Array(NB * NB), qf = new Float32Array(NB * NB);
    let conv = 0;
    for (let i = 0; i < NB; i++) {
      const rowW = new Float64Array(NB), rowP = new Float64Array(NB), rowG = new Float64Array(NB);
      for (let k = 0; k < NB; k++) {
        const c = i * NB + k, x = w[c];
        if (!x) continue;
        const m = ws[c] / x, read = Math.min(m, cap), pages = Math.ceil(read / 500);
        const ks = opts.descendants ? G.binOf(Math.max(1, Math.round(m) - 1)) : k;
        kOf[c] = ks;
        rowW[ks] += x; rowP[ks] += x * read; rowG[ks] += x * pages;
        Wi[i] += x; Si[i] += x * m; Pi[i] += x * read; Gi[i] += x * pages;
        qf[c] = wq ? Math.min(1, wq[c] / x) : (kMid(k) < (m - 1) / 2 ? 1 : 0);
        quietW[i] += x * qf[c];
        if (E[k] <= 2) chainW[i] += x;
        conv += x;
      }
      for (let t = 0; t < NB; t++) {
        cumW[i * (NB + 1) + t + 1] = cumW[i * (NB + 1) + t] + rowW[t];
        cumP[i * (NB + 1) + t + 1] = cumP[i * (NB + 1) + t] + rowP[t];
        cumG[i * (NB + 1) + t + 1] = cumG[i * (NB + 1) + t] + rowG[t];
      }
    }
    /* Chance that a sample catches a conversation in size bin i. A bin holds a range of sizes, so the chance is
       taken at the bin's two ends, weighted to reproduce the bin's mean size, not at the mean size itself. */
    const det = new Float32Array(H_GRID.length * P_GRID.length * NB);
    for (let i = 0; i < NB; i++) {
      if (!(Wi[i] > 0)) continue;
      const lo = E[i], hi = i + 1 < NB ? E[i + 1] - 1 : E[i], m = Si[i] / Wi[i];
      const wl = hi > lo ? Math.min(1, Math.max(0, (hi - m) / (hi - lo))) : 1;
      for (let a = 0; a < H_GRID.length; a++)
        for (let b = 0; b < P_GRID.length; b++)
          det[(a * P_GRID.length + b) * NB + i] = wl * binomSf(H_GRID[a], lo - 1, P_GRID[b]) + (1 - wl) * binomSf(H_GRID[a], hi - 1, P_GRID[b]);
    }
    const tierW = new Float64Array(NB + 1), tierS = new Float64Array(NB + 1), tierP = new Float64Array(NB + 1);
    const tierQuiet = new Float64Array(NB + 1), tierChain = new Float64Array(NB + 1);
    for (let i = NB - 1; i >= 0; i--) {
      tierW[i] = tierW[i + 1] + Wi[i]; tierS[i] = tierS[i + 1] + Si[i]; tierP[i] = tierP[i + 1] + Pi[i];
      tierQuiet[i] = tierQuiet[i + 1] + quietW[i]; tierChain[i] = tierChain[i + 1] + chainW[i];
    }
    const cuts = [];
    for (let j = 0; j < NB; j++) if (E[j] >= MIN_CUT && tierW[j] > 0) cuts.push(j);
    return { w, ws, cap, descendants: !!opts.descendants, Wi, Si, Pi, Gi, cumW, cumP, cumG, det, kOf, qf,
             quietW, chainW, tierW, tierS, tierP, tierQuiet, tierChain, cuts, conv };
  }

  const DEFAULT_PRICES = { streamPost: 1, traffic: 1, count: 2, rootDays: 2, reread: 1, expansions: 0, requestFee: 0 };

  /* Evaluate every plan at every cutoff in one pass.
     opt: { recall, budget, cutSel, allowRoot, allowSample, stream: {mode:'buy'|'free', p} }
     For each cutoff and family it returns
       atFloor   the cheapest tested plan that finds the required share (admitting only as many candidates as needed)
       inBudget  the tested plan that finds most within the budget (admitting a share of candidates if it must)
     and, at cutSel, the most each family finds at each level of spending (frontier). */
  function evaluate(pop, pr, opt) {
    pr = Object.assign({}, DEFAULT_PRICES, pr);
    const unit = pr.reread * (1 + pr.expansions), fr = pr.requestFee;
    const N1 = NB + 1, cuts = pop.cuts, nc = cuts.length, PL = P_GRID.length;
    const fams = ['root', 'sample', 'both'];
    const res = cuts.map(() => ({ root: {}, sample: {}, both: {} }));
    const raw = { root: [], sample: [], both: [] };          // at cutSel: [fixed cost, cost that scales with admission, recall]
    const selIdx = cuts.indexOf(opt.cutSel);
    const free = !!(opt.stream && opt.stream.mode === 'free'), fullStream = free && opt.stream.p >= 1;
    const offer = (fam, q, pol0, disc, rest, recall) => {
      // pol0: the plan with every candidate admitted; rest = its costs that scale with the share admitted
      const slot = res[q][fam];
      const mk = (a) => Object.assign({}, pol0, { admit: a, cost: disc + a * rest, finding: disc, counting: a * pol0.counting, wasted: a * pol0.wasted,
                                                  reading: a * pol0.reading, recall: a * recall, found: a * pol0.found, posts: a * pol0.posts });
      if (recall >= opt.recall - 1e-9) {
        const a = Math.min(1, opt.recall / recall), c = disc + a * rest;
        if (!slot.atFloor || c < slot.atFloor.cost) slot.atFloor = mk(a);
      }
      if (opt.budget > disc) {
        const a = rest > 0 ? Math.min(1, (opt.budget - disc) / rest) : 1, r = a * recall, b = slot.inBudget;
        if (!b || r > b.recall + 1e-9 || (r > b.recall - 1e-9 && disc + a * rest < b.cost)) slot.inBudget = mk(a);
      }
      if (q === selIdx) raw[fam].push(disc, rest, recall);
    };
    const consider = (fam, base, TS, PS, GS, readScale) => {
      // base: {disc, counts, cand, postsAll, count, T, h, p}; TS/PS/GS: conversations, posts, pages found at or above each size bin
      const pgAll = GS[0];
      for (let q = 0; q < nc; q++) {
        const j = cuts[q], tr = TS[j], po = PS[j], pg = GS[j];
        if (tr <= 0) continue;
        const wasted = base.count ? 0 : unit * readScale * Math.max(0, base.postsAll - po) + fr * Math.max(0, pgAll - pg);
        const reading = unit * readScale * po + fr * pg;
        offer(fam, q, { family: fam, T: base.T, h: base.h, p: base.p, count: base.count, counting: base.counts, wasted, reading, found: tr, posts: po, cand: base.cand, cut: j },
              base.disc, base.counts + wasted + reading, tr / pop.tierW[j]);
      }
    };
    const pIdx = [];
    if (free) {
      let best = 0; for (let b = 0; b < PL; b++) if (Math.abs(Math.log(P_GRID[b] / opt.stream.p)) < Math.abs(Math.log(P_GRID[best] / opt.stream.p))) best = b;
      pIdx.push(best);
    } else for (let b = 0; b < PL; b++) pIdx.push(b);
    const streamCost = (p) => (free ? 0 : pr.streamPost * pr.traffic * p);
    const TS = new Float64Array(N1), PS = new Float64Array(N1), GS = new Float64Array(N1);

    // ---- root search alone
    const rootParts = [];                      // per threshold bin t: suffix sums of the root-visible part
    for (let t = 0; t < NB; t++) {
      const rT = new Float64Array(N1), rP = new Float64Array(N1), rG = new Float64Array(N1);
      let cand = 0, posts = 0;
      for (let i = NB - 1; i >= 0; i--) {
        const a = pop.Wi[i] - pop.cumW[i * N1 + t], b = pop.Pi[i] - pop.cumP[i * N1 + t], c = pop.Gi[i] - pop.cumG[i * N1 + t];
        rT[i] = rT[i + 1] + a; rP[i] = rP[i + 1] + b; rG[i] = rG[i + 1] + c; cand += a; posts += b;
      }
      rootParts.push({ rT, rP, rG, cand, posts });
      if (opt.allowRoot === false || cand <= 0) continue;
      const disc = pr.rootDays * cand + fr * cand / 500;
      consider('root', { disc, counts: pr.count * cand, cand, postsAll: posts, count: true, T: E[t] }, rT, rP, rG, 1);
      consider('root', { disc, counts: 0, cand, postsAll: posts, count: false, T: E[t] }, rT, rP, rG, 1);
    }
    // ---- a full stream outside the quota already delivers every reply: sizes are known and only roots are missing
    if (opt.allowSample !== false && fullStream) {
      for (let q = 0; q < nc; q++) {
        const j = cuts[q], tr = pop.tierW[j], reading = unit * tr + fr * tr / 100;
        offer('sample', q, { family: 'sample', p: 1, h: E[j] - 1, count: false, full: true, counting: 0, wasted: 0, reading, found: tr, posts: pop.tierP[j], cand: tr, cut: j }, 0, reading, 1);
      }
    }
    // ---- reply sample alone, and root search plus sample
    if (opt.allowSample !== false && !fullStream) {
      const tList = opt.allowRoot === false ? [] : T_BOTH.map((v) => E.indexOf(v));
      for (let a = 0; a < H_GRID.length; a++) {
        for (const b of pIdx) {
          const d = pop.det, off = (a * PL + b) * NB, p = P_GRID[b], sc = streamCost(p);
          let cand = 0, posts = 0; TS[NB] = PS[NB] = GS[NB] = 0;
          for (let i = NB - 1; i >= 0; i--) {
            const x = d[off + i];
            TS[i] = TS[i + 1] + pop.Wi[i] * x; PS[i] = PS[i + 1] + pop.Pi[i] * x; GS[i] = GS[i + 1] + pop.Gi[i] * x;
            cand += pop.Wi[i] * x; posts += pop.Pi[i] * x;
          }
          // a free stream has already delivered its share p of each conversation's replies
          const rs = free ? 1 - p : 1;
          consider('sample', { disc: sc, counts: pr.count * cand, cand, postsAll: posts, count: true, h: H_GRID[a], p }, TS, PS, GS, rs);
          consider('sample', { disc: sc, counts: 0, cand, postsAll: posts, count: false, h: H_GRID[a], p }, TS, PS, GS, rs);
          if (H_GRID[a] > 5) continue;
          for (const t of tList) {
            const rp = rootParts[t];
            if (rp.cand <= 0) continue;
            let c2 = 0, p2 = 0; TS[NB] = PS[NB] = GS[NB] = 0;
            for (let i = NB - 1; i >= 0; i--) {
              const x = d[off + i], wl = pop.cumW[i * N1 + t] * x, pl = pop.cumP[i * N1 + t] * x, gl = pop.cumG[i * N1 + t] * x;
              TS[i] = TS[i + 1] + wl + (rp.rT[i] - rp.rT[i + 1]); PS[i] = PS[i + 1] + pl + (rp.rP[i] - rp.rP[i + 1]);
              GS[i] = GS[i + 1] + gl + (rp.rG[i] - rp.rG[i + 1]); c2 += wl; p2 += pl;
            }
            const disc = sc + pr.rootDays * rp.cand + fr * rp.cand / 500;
            consider('both', { disc, counts: pr.count * (rp.cand + c2), cand: rp.cand + c2, postsAll: rp.posts + p2, count: true, T: E[t], h: H_GRID[a], p }, TS, PS, GS, 1);
          }
        }
      }
    }
    // ---- frontier at cutSel: the most each family finds at each level of spending, partial admission included
    const frontier = { root: [], sample: [], both: [] };
    let lo = Infinity, hi = 0;
    for (const f of fams) for (let i = 0; i < raw[f].length; i += 3) { const c = raw[f][i] + raw[f][i + 1]; if (c > 0 && c < lo) lo = c; if (c > hi) hi = c; }
    if (isFinite(lo)) {
      lo = Math.max(lo / 20, 1e-9); hi = Math.min(hi, 3);
      for (const f of fams) {
        const r = raw[f]; if (!r.length) continue;
        for (let g = 0; g <= 140; g++) {
          const c = lo * Math.pow(hi / lo, g / 140); let best = 0;
          for (let i = 0; i < r.length; i += 3) { const d = r[i]; if (c <= d) continue; const v = r[i + 2] * (r[i + 1] > 0 ? Math.min(1, (c - d) / r[i + 1]) : 1); if (v > best) best = v; }
          frontier[f].push([c, best]);
        }
      }
    }
    const pick = (q, key) => {
      let best = null;
      for (const f of fams) {
        const c = res[q][f][key]; if (!c) continue;
        if (!best) best = c;
        else if (key === 'atFloor' ? c.cost < best.cost : (c.recall > best.recall + 1e-9 || (c.recall > best.recall - 1e-9 && c.cost < best.cost))) best = c;
      }
      return best;
    };
    const byCut = cuts.map((j, q) => ({ cut: j, size: E[j], tierW: pop.tierW[j], tierPosts: pop.tierP[j], families: res[q],
                                         atFloor: pick(q, 'atFloor'), inBudget: pick(q, 'inBudget') }));
    return { byCut, frontier, selIdx };
  }

  /* Root search at one fixed threshold with every candidate admitted. T is rounded down to a bin edge; the
     threshold actually used is returned as T. */
  function rootPolicy(pop, pr, j, T, count) {
    pr = Object.assign({}, DEFAULT_PRICES, pr);
    const unit = pr.reread * (1 + pr.expansions), N1 = NB + 1, fr = pr.requestFee;
    let t = 0; for (let x = 0; x < NB; x++) if (E[x] <= T) t = x;
    let cand = 0, posts = 0, pages = 0, tr = 0, po = 0, pg = 0;
    for (let i = 0; i < NB; i++) {
      const a = pop.Wi[i] - pop.cumW[i * N1 + t], b = pop.Pi[i] - pop.cumP[i * N1 + t], c = pop.Gi[i] - pop.cumG[i * N1 + t];
      cand += a; posts += b; pages += c; if (i >= j) { tr += a; po += b; pg += c; }
    }
    if (cand <= 0 || tr <= 0) return null;
    const finding = pr.rootDays * cand + fr * cand / 500, counting = count === false ? 0 : pr.count * cand;
    const wasted = count === false ? unit * (posts - po) + fr * (pages - pg) : 0, reading = unit * po + fr * pg;
    return { family: 'root', T: E[t], count: count !== false, admit: 1, cost: finding + counting + wasted + reading, finding, counting, wasted, reading,
             recall: tr / pop.tierW[j], found: tr, posts: po, cand, cut: j };
  }

  /* Who a plan finds: by size bin and by shape (root-driven or quiet-root). */
  function coverage(pop, pol) {
    const PL = P_GRID.length, j = pol.cut, adm = pol.admit == null ? 1 : pol.admit;
    const tBin = pol.T ? E.indexOf(pol.T) : -1;
    let off = -1;
    if (pol.p && !pol.full) {
      let b = 0; for (let x = 0; x < PL; x++) if (Math.abs(P_GRID[x] - pol.p) < Math.abs(P_GRID[b] - pol.p)) b = x;
      off = (H_GRID.indexOf(pol.h) * PL + b) * NB;
    }
    const num = { driven: new Float64Array(NB), quiet: new Float64Array(NB) }, den = { driven: new Float64Array(NB), quiet: new Float64Array(NB) };
    const tot = { driven: [0, 0], quiet: [0, 0], chain: [0, 0] };
    for (let i = 0; i < NB; i++) {
      const dp = pol.full ? 1 : off >= 0 ? pop.det[off + i] : 0;
      for (let k = 0; k < NB; k++) {
        const c = i * NB + k, x = pop.w[c]; if (!x) continue;
        const pi = adm * ((tBin >= 0 && pop.kOf[c] >= tBin) ? 1 : dp), q = pop.qf[c];
        num.quiet[i] += x * q * pi; den.quiet[i] += x * q; num.driven[i] += x * (1 - q) * pi; den.driven[i] += x * (1 - q);
        if (i >= j) {
          tot.quiet[0] += x * q * pi; tot.quiet[1] += x * q; tot.driven[0] += x * (1 - q) * pi; tot.driven[1] += x * (1 - q);
          if (E[k] <= 2) { tot.chain[0] += x * pi; tot.chain[1] += x; }
        }
      }
    }
    const incl = { driven: [], quiet: [] };
    for (const cls of ['driven', 'quiet']) for (let i = 0; i < NB; i++) incl[cls].push(den[cls][i] > 0 ? num[cls][i] / den[cls][i] : null);
    const all = tot.driven[1] + tot.quiet[1], got = tot.driven[0] + tot.quiet[0];
    return { incl, weight: den,
             foundDriven: tot.driven[1] ? tot.driven[0] / tot.driven[1] : null, foundQuiet: tot.quiet[1] ? tot.quiet[0] / tot.quiet[1] : null,
             foundChain: tot.chain[1] ? tot.chain[0] / tot.chain[1] : null,
             trueQuietShare: all ? tot.quiet[1] / all : null, collectedQuietShare: got ? tot.quiet[0] / got : null,
             trueChainShare: all ? tot.chain[1] / all : null, collectedChainShare: got ? tot.chain[0] / got : null };
  }

  /* Blend two population tables by share of replies. */
  function blend(a, b, share) {
    const n = a.w.length, w = new Float64Array(n), ws = new Float64Array(n), wq = a.wq && b.wq ? new Float64Array(n) : null;
    for (let c = 0; c < n; c++) { w[c] = (1 - share) * a.w[c] + share * b.w[c]; ws[c] = (1 - share) * a.ws[c] + share * b.ws[c]; if (wq) wq[c] = (1 - share) * a.wq[c] + share * b.wq[c]; }
    return { w, ws, wq };
  }
  /* Cells are [size bin, root-reply bin, conversations per reply, mean size, share that are quiet-root]. */
  function fromCells(cells) {
    const w = new Float64Array(NB * NB), ws = new Float64Array(NB * NB), has = cells.length && cells[0].length > 4, wq = has ? new Float64Array(NB * NB) : null;
    for (const [i, k, x, m, q] of cells) { w[i * NB + k] = x; ws[i * NB + k] = x * m; if (wq) wq[i * NB + k] = x * q; }
    return { w, ws, wq };
  }
  /* Share of replies in conversations of at least each size. */
  function shareCurve(pop) {
    const out = []; let acc = 0;
    for (let i = NB - 1; i >= 0; i--) { acc += pop.Si[i] - pop.Wi[i]; out[i] = acc; }
    return out;
  }

  const api = { buildPop, evaluate, rootPolicy, coverage, blend, fromCells, shareCurve, binomSf, P_GRID, H_GRID, DEFAULT_PRICES, MIN_CUT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.COST = api;
})(typeof self !== 'undefined' ? self : globalThis);
