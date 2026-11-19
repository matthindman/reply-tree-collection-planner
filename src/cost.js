/* cost.js — what each way of collecting costs and finds, for a population table.

   Costs are in posts read per reply in the population (1.0 = reading every reply once).
   Ways of finding conversations:
     root    search for roots with at least T replies (min_replies:T), count each, fetch those that qualify
     sample  a random share p of replies; a conversation becomes a candidate at its h-th sampled reply
     both    root search, plus a sample for the conversations root search cannot see
   A candidate is either counted once (and fetched only if it reaches the cutoff) or fetched outright.
   Static model: a conversation is judged on its final size. No DOM access. */
(function (root) {
  'use strict';
  const G = (typeof module !== 'undefined' && module.exports) ? require('./sim.js') : root.GRT;
  const E = G.EDGES, NB = G.NB;

  const P_GRID = (() => { const a = []; for (let i = 0; i <= 120; i++) a.push(Math.pow(10, -4 + i / 30)); a[120] = 1; return a; })();
  const H_GRID = [1, 2, 3, 5, 10, 20, 50, 100];
  const T_BOTH = E.filter((e) => e >= 2 && e <= 5000);      // root thresholds tried in the combined strategy
  const MIN_CUT = 20;

  function binomSf(h, n, p) {                                // P(Binomial(n,p) >= h)
    if (n < h) return 0;
    if (p >= 1) return 1;
    let pmf = Math.exp(n * Math.log1p(-p)), cdf = pmf; const r = p / (1 - p);
    for (let i = 0; i < h - 1; i++) { pmf *= (n - i) / (i + 1) * r; cdf += pmf; }
    return cdf >= 1 ? 0 : 1 - cdf;
  }

  /* pop: {w, ws} per reply by cell (size bin i, root-reply bin k).
     opts.cap: read at most this many posts of any conversation (Infinity = complete).
     opts.descendants: min_replies counts all replies in the conversation, not direct replies. */
  function buildPop(w, ws, opts) {
    opts = opts || {};
    const cap = opts.cap || Infinity;
    const Wi = new Float64Array(NB), Si = new Float64Array(NB), Pi = new Float64Array(NB), Gi = new Float64Array(NB);
    const cumW = new Float64Array(NB * (NB + 1)), cumP = new Float64Array(NB * (NB + 1)), cumG = new Float64Array(NB * (NB + 1));
    const quietW = new Float64Array(NB), chainW = new Float64Array(NB), kOf = new Int16Array(NB * NB);
    let conv = 0, overCap = new Float64Array(NB);
    for (let i = 0; i < NB; i++) {
      const rowW = new Float64Array(NB), rowP = new Float64Array(NB), rowG = new Float64Array(NB);
      for (let k = 0; k < NB; k++) {
        const c = i * NB + k, x = w[c];
        if (!x) continue;
        const m = ws[c] / x, read = Math.min(m, cap);
        const kmid = k < 20 ? E[k] : Math.sqrt(E[k] * ((k + 1 < NB ? E[k + 1] : 2 * E[k]) - 1));
        const ks = opts.descendants ? G.binOf(Math.max(1, Math.round(m) - 1)) : k;
        kOf[c] = ks;
        rowW[ks] += x; rowP[ks] += x * read; rowG[ks] += x * Math.ceil(read / 500);
        Wi[i] += x; Si[i] += x * m; Pi[i] += x * read; Gi[i] += x * Math.ceil(read / 500);
        if (kmid < (m - 1) / 2) quietW[i] += x;
        if (kmid <= 2) chainW[i] += x;
        if (m > cap) overCap[i] += x;
        conv += x;
      }
      for (let t = 0; t < NB; t++) {
        cumW[i * (NB + 1) + t + 1] = cumW[i * (NB + 1) + t] + rowW[t];
        cumP[i * (NB + 1) + t + 1] = cumP[i * (NB + 1) + t] + rowP[t];
        cumG[i * (NB + 1) + t + 1] = cumG[i * (NB + 1) + t] + rowG[t];
      }
    }
    const nRep = new Float64Array(NB);
    for (let i = 0; i < NB; i++) nRep[i] = Wi[i] > 0 ? Math.max(1, Math.round(Si[i] / Wi[i]) - 1) : 0;
    const det = new Float32Array(H_GRID.length * P_GRID.length * NB);
    for (let a = 0; a < H_GRID.length; a++)
      for (let b = 0; b < P_GRID.length; b++)
        for (let i = 0; i < NB; i++)
          if (Wi[i] > 0) det[(a * P_GRID.length + b) * NB + i] = binomSf(H_GRID[a], nRep[i], P_GRID[b]);
    // tiers: conversations and posts at or above each size bin
    const tierW = new Float64Array(NB + 1), tierS = new Float64Array(NB + 1), tierP = new Float64Array(NB + 1);
    const tierQuiet = new Float64Array(NB + 1), tierChain = new Float64Array(NB + 1), tierOver = new Float64Array(NB + 1);
    for (let i = NB - 1; i >= 0; i--) {
      tierW[i] = tierW[i + 1] + Wi[i]; tierS[i] = tierS[i + 1] + Si[i]; tierP[i] = tierP[i + 1] + Pi[i];
      tierQuiet[i] = tierQuiet[i + 1] + quietW[i]; tierChain[i] = tierChain[i + 1] + chainW[i]; tierOver[i] = tierOver[i + 1] + overCap[i];
    }
    const cuts = [];
    for (let j = 0; j < NB; j++) if (E[j] >= MIN_CUT && tierW[j] > 0) cuts.push(j);
    return { w, ws, cap, descendants: !!opts.descendants, Wi, Si, Pi, Gi, cumW, cumP, cumG, det, nRep, kOf,
             quietW, chainW, tierW, tierS, tierP, tierQuiet, tierChain, tierOver, cuts, conv };
  }

  const DEFAULT_PRICES = { streamPost: 1, traffic: 1, count: 2, rootDays: 2, reread: 1, expansions: 0, requestFee: 0 };

  /* Evaluate every policy at every cutoff in one pass.
     opt: { recall, budget, cutSel, allowRoot, allowSample, stream: {mode:'buy'|'free', p} }
     Returns per cutoff and per family the cheapest policy that meets the recall floor (atFloor) and the
     policy that finds most within the budget (inBudget); plus the cost/recall frontier at cutSel. */
  function evaluate(pop, pr, opt) {
    pr = Object.assign({}, DEFAULT_PRICES, pr);
    const unit = pr.reread * (1 + pr.expansions), fr = pr.requestFee;
    const N1 = NB + 1, cuts = pop.cuts, nc = cuts.length, PL = P_GRID.length;
    const fams = ['root', 'sample', 'both'];
    const res = cuts.map(() => ({ root: {}, sample: {}, both: {} }));
    const frontier = { root: [], sample: [], both: [] };
    const selIdx = cuts.indexOf(opt.cutSel);
    const consider = (fam, base, TS, PS, GS) => {
      // base: {disc, counts, cand, postsAll, count, T, h, p}
      for (let q = 0; q < nc; q++) {
        const j = cuts[q], tr = TS[j], po = PS[j], pg = GS[j];
        if (tr <= 0) continue;
        const wasted = base.count ? 0 : unit * Math.max(0, base.postsAll - po);
        const reading = unit * po + fr * pg;
        const cost = base.disc + base.counts + wasted + reading, recall = tr / pop.tierW[j];
        const mk = () => ({ family: fam, T: base.T, h: base.h, p: base.p, count: base.count, cost, finding: base.disc,
                            counting: base.counts, wasted, reading, recall, found: tr, cand: base.cand, cut: j });
        const slot = res[q][fam];
        if (recall >= opt.recall - 1e-9) { if (!slot.atFloor || cost < slot.atFloor.cost) slot.atFloor = mk(); }
        if (cost <= opt.budget) {
          const b = slot.inBudget;
          if (!b || recall > b.recall + 1e-9 || (recall > b.recall - 1e-9 && cost < b.cost)) slot.inBudget = mk();
        }
        if (q === selIdx) frontier[fam].push([cost, recall, base.T, base.h, base.p, base.count ? 1 : 0]);
      }
    };
    const pIdx = [];
    if (opt.stream && opt.stream.mode === 'free') {
      let best = 0; for (let b = 0; b < PL; b++) if (Math.abs(Math.log(P_GRID[b] / opt.stream.p)) < Math.abs(Math.log(P_GRID[best] / opt.stream.p))) best = b;
      pIdx.push(best);
    } else for (let b = 0; b < PL; b++) pIdx.push(b);
    const streamCost = (p) => (opt.stream && opt.stream.mode === 'free') ? 0 : pr.streamPost * pr.traffic * p;
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
      consider('root', { disc, counts: pr.count * cand, cand, postsAll: posts, count: true, T: E[t] }, rT, rP, rG);
      consider('root', { disc, counts: 0, cand, postsAll: posts, count: false, T: E[t] }, rT, rP, rG);
    }
    // ---- reply sample alone, and root search plus sample
    if (opt.allowSample !== false) {
      const tList = opt.allowRoot === false ? [] : T_BOTH.map((v) => E.indexOf(v));
      for (let a = 0; a < H_GRID.length; a++) {
        for (const b of pIdx) {
          const d = pop.det, off = (a * PL + b) * NB, p = P_GRID[b], sc = streamCost(p);
          // all conversations
          let cand = 0, posts = 0; TS[NB] = PS[NB] = GS[NB] = 0;
          for (let i = NB - 1; i >= 0; i--) {
            const x = d[off + i];
            TS[i] = TS[i + 1] + pop.Wi[i] * x; PS[i] = PS[i + 1] + pop.Pi[i] * x; GS[i] = GS[i + 1] + pop.Gi[i] * x;
            cand += pop.Wi[i] * x; posts += pop.Pi[i] * x;
          }
          consider('sample', { disc: sc, counts: pr.count * cand, cand, postsAll: posts, count: true, h: H_GRID[a], p }, TS, PS, GS);
          consider('sample', { disc: sc, counts: 0, cand, postsAll: posts, count: false, h: H_GRID[a], p }, TS, PS, GS);
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
            consider('both', { disc, counts: pr.count * (rp.cand + c2), cand: rp.cand + c2, postsAll: rp.posts + p2, count: true, T: E[t], h: H_GRID[a], p }, TS, PS, GS);
          }
        }
      }
    }
    // ---- frontier: cheapest cost for each level of recall
    for (const f of fams) {
      const pts = frontier[f].sort((x, y) => x[0] - y[0]); const out = []; let best = -1;
      for (const pt of pts) if (pt[1] > best + 1e-6) { out.push(pt); best = pt[1]; }
      frontier[f] = out;
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


  /* Root search at one fixed threshold (used to show root search at half the cutoff). */
  function rootPolicy(pop, pr, j, T, count) {
    pr = Object.assign({}, DEFAULT_PRICES, pr);
    const unit = pr.reread * (1 + pr.expansions), N1 = NB + 1;
    let t = 0; for (let x = 0; x < NB; x++) if (E[x] <= T) t = x;
    let cand = 0, posts = 0, tr = 0, po = 0, pg = 0;
    for (let i = 0; i < NB; i++) {
      const a = pop.Wi[i] - pop.cumW[i * N1 + t], b = pop.Pi[i] - pop.cumP[i * N1 + t], c = pop.Gi[i] - pop.cumG[i * N1 + t];
      cand += a; posts += b; if (i >= j) { tr += a; po += b; pg += c; }
    }
    if (cand <= 0 || tr <= 0) return null;
    const finding = pr.rootDays * cand + pr.requestFee * cand / 500, counting = count === false ? 0 : pr.count * cand;
    const wasted = count === false ? unit * (posts - po) : 0, reading = unit * po + pr.requestFee * pg;
    return { family: 'root', T: E[t], count: count !== false, cost: finding + counting + wasted + reading, finding, counting, wasted, reading,
             recall: tr / pop.tierW[j], found: tr, cand, cut: j };
  }

  /* Who a policy finds: by size bin and by shape (root-driven or quiet-root). */
  function coverage(pop, pol) {
    const N1 = NB + 1, PL = P_GRID.length, j = pol.cut;
    const tBin = pol.T ? E.indexOf(pol.T) : -1;
    let off = -1;
    if (pol.p) {
      let b = 0; for (let x = 0; x < PL; x++) if (Math.abs(P_GRID[x] - pol.p) < Math.abs(P_GRID[b] - pol.p)) b = x;
      off = (H_GRID.indexOf(pol.h) * PL + b) * NB;
    }
    const num = { driven: new Float64Array(NB), quiet: new Float64Array(NB) }, den = { driven: new Float64Array(NB), quiet: new Float64Array(NB) };
    const tot = { driven: [0, 0], quiet: [0, 0], chain: [0, 0] };
    for (let i = 0; i < NB; i++) {
      const dp = off >= 0 ? pop.det[off + i] : 0;
      for (let k = 0; k < NB; k++) {
        const c = i * NB + k, x = pop.w[c]; if (!x) continue;
        const m = pop.ws[c] / x, kmid = k < 20 ? E[k] : Math.sqrt(E[k] * ((k + 1 < NB ? E[k + 1] : 2 * E[k]) - 1));
        const cls = kmid < (m - 1) / 2 ? 'quiet' : 'driven';
        const pi = (tBin >= 0 && pop.kOf[c] >= tBin) ? 1 : dp;
        num[cls][i] += x * pi; den[cls][i] += x;
        if (i >= j) { tot[cls][0] += x * pi; tot[cls][1] += x; if (kmid <= 2) { tot.chain[0] += x * pi; tot.chain[1] += x; } }
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
    const w = new Float64Array(a.w.length), ws = new Float64Array(a.w.length);
    for (let c = 0; c < w.length; c++) { w[c] = (1 - share) * a.w[c] + share * b.w[c]; ws[c] = (1 - share) * a.ws[c] + share * b.ws[c]; }
    return { w, ws };
  }
  function fromCells(cells) {
    const w = new Float64Array(NB * NB), ws = new Float64Array(NB * NB);
    for (const [i, k, x, m] of cells) { w[i * NB + k] = x; ws[i * NB + k] = x * m; }
    return { w, ws };
  }
  /* Share of replies in conversations of at least each size. */
  function shareCurve(pop) {
    const out = []; let acc = 0;
    for (let i = NB - 1; i >= 0; i--) { acc += pop.Si[i] - pop.Wi[i]; out[i] = acc; }
    return out;
  }

  const api = { buildPop, evaluate, rootPolicy, coverage, blend, fromCells, shareCurve, P_GRID, H_GRID, DEFAULT_PRICES, MIN_CUT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.COST = api;
})(typeof self !== 'undefined' ? self : globalThis);
