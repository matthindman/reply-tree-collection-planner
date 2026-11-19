/* sim.js — the stochastic reply-tree model (GRT, 18 parameters), ported from
   reply-tree-models/claude/general_model/code/gm_model.py.

   One conversation:
     K direct replies to the root: two-component discretised lognormal mixture (w, a1, t1, a2, t2).
     theta ~ Normal(0,1): a per-conversation trait.
     Every reply either continues (exactly one child) or ends; an ending reply branches into D >= 2
     children with probability phi. Chains of one-child replies are "segments".
   Only the size S and K are kept, binned on the planner's grid.

   Sampling: a mixture of the model itself, two "popular root" strata and a "persistent dialogue"
   stratum, combined with balance-heuristic weights, so rare large conversations are resolved with
   few simulated trees. Estimates are unbiased for the model.

   Runs in Node (module.exports) and as a Web Worker (onmessage at the bottom). No DOM access. */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ grid
  function makeEdges() {
    const e = [];
    for (let k = 1; k <= 20; k++) e.push(k);
    for (let dec = 10; dec < 1e7; dec *= 10)
      for (const x of [2.5, 3, 4, 5, 6, 7.5, 10, 12.5, 15, 20]) e.push(Math.round(x * dec));
    return e;
  }
  const EDGES = makeEdges();
  const NB = EDGES.length;
  const SMALL = new Uint8Array(4096);
  for (let v = 1, b = 0; v < 4096; v++) { while (b + 1 < NB && EDGES[b + 1] <= v) b++; SMALL[v] = b; }
  function binOf(v) {
    if (v < 4096) return SMALL[v < 1 ? 1 : v | 0];
    let lo = SMALL[4095], hi = NB - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (EDGES[m] <= v) lo = m; else hi = m - 1; }
    return lo;
  }

  // ------------------------------------------------------------------ special functions
  const SQRT2 = Math.SQRT2, LOG_SQRT_2PI = 0.9189385332046727;
  function logQ(y) {                       // log of the standard normal upper tail
    if (y <= -2) return Math.log1p(-Math.exp(logQ(-y)));
    if (y < 2) {                           // series for erf
      const z = y / SQRT2; let term = z, sum = z;
      for (let n = 1; n < 60; n++) { term *= -z * z / n; sum += term / (2 * n + 1); }
      return Math.log(0.5 - sum / Math.sqrt(Math.PI));
    }
    let cf = y;                            // continued fraction, evaluated from the tail
    for (let n = 80; n >= 1; n--) cf = y + n / cf;
    return -0.5 * y * y - LOG_SQRT_2PI - Math.log(cf);
  }
  function zeta(a) {                       // Riemann zeta for a > 1, Euler-Maclaurin
    const N = 12; let s = 0;
    for (let n = 1; n < N; n++) s += Math.pow(n, -a);
    return s + Math.pow(N, 1 - a) / (a - 1) + 0.5 * Math.pow(N, -a) + a * Math.pow(N, -a - 1) / 12
      - a * (a + 1) * (a + 2) * Math.pow(N, -a - 3) / 720;
  }
  const logistic = (z) => 1 / (1 + Math.exp(-z));

  // ------------------------------------------------------------------ random numbers
  function makeRng(seed) {
    let a = (seed >>> 0) || 1, spare = 0, has = false;
    const u = () => {                      // mulberry32, uniform on (0,1)
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
    };
    const n = () => {                      // Marsaglia polar
      if (has) { has = false; return spare; }
      let x, y, r;
      do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r >= 1 || r === 0);
      const f = Math.sqrt(-2 * Math.log(r) / r);
      spare = y * f; has = true; return x * f;
    };
    return { u, n };
  }

  // ------------------------------------------------------------------ root law
  const X_MAX = Math.log(2e6), DX = 0.004;     // conversations above 2 million direct replies are capped
  function rootTable(P) {
    const n = Math.ceil(X_MAX / DX) + 1, ls = new Float64Array(n);
    const y1 = P.a1 / P.t1, y2 = P.a2 / P.t2, q1 = logQ(y1), q2 = logQ(y2);
    const l1 = Math.log(P.w), l2 = Math.log1p(-P.w);
    for (let i = 0; i < n; i++) {
      const x = i * DX;
      const A = l1 + logQ(P.t1 * x + y1) - q1, B = l2 + logQ(P.t2 * x + y2) - q2;
      const m = Math.max(A, B);
      ls[i] = m + Math.log(Math.exp(A - m) + Math.exp(B - m));
    }
    ls[0] = 0;
    return ls;
  }
  function invRoot(ls, target) {               // x with log P(Z >= x) = target
    const n = ls.length;
    if (target <= ls[n - 1]) return X_MAX;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ls[m] >= target) lo = m; else hi = m; }
    const d = ls[lo] - ls[hi];
    return (lo + (d > 0 ? (ls[lo] - target) / d : 0)) * DX;
  }
  function xAtSf(ls, logsf) { return invRoot(ls, logsf); }

  // ------------------------------------------------------------------ one conversation
  const MAX_POSTS = 3e6;
  function makeTreeSim(P, rng) {
    const cache = new Map();
    const consts = (K) => {
      let c = cache.get(K);
      if (c) return c;
      const x = Math.log(K);
      const al1 = 1 + (P.alpha0 - 1) * Math.exp(-P.b1 * x), al2 = 1 + (P.alpha0 - 1) * Math.exp(-P.b2 * x);
      c = { u1z: P.c0 - P.c1 * x, base: P.mu - P.gam * x, al1, al2,
            phi1: logistic(P.g0 + P.f1 * x) / (1 + zeta(al1)), phi2: logistic(P.f0 + P.f1 * x) / (1 + zeta(al2)) };
      if (cache.size < 20000) cache.set(K, c);
      return c;
    };
    const u = rng.u, nrm = rng.n, tau = P.tau;
    return function (K, theta) {                // returns the conversation's size (root included)
      const c = consts(K);
      const u1 = logistic(c.u1z + P.s1 * theta), base = c.base + P.sig * theta;
      let size = 1, pend = 0, rootLeft = K;
      while (rootLeft > 0 || pend > 0) {
        const isRoot = rootLeft > 0;
        if (isRoot) rootLeft--; else pend--;
        const z = base + (tau > 0 ? tau * nrm() : 0);
        const logU = z > 35 ? -Math.exp(-z) : -Math.log1p(Math.exp(-z));
        const cont = u() < (isRoot ? u1 : Math.exp(logU));
        let len = 1;
        if (cont) len = 2 + Math.floor(Math.log(u()) / logU);
        size += len;
        if (!(size < MAX_POSTS)) return MAX_POSTS;
        const lvl1End = isRoot && !cont;
        if (u() < (lvl1End ? c.phi1 : c.phi2)) {
          const logy = -Math.log(u()) / (lvl1End ? c.al1 : c.al2);
          if (logy > 14.5) return MAX_POSTS;
          pend += 1 + Math.floor(Math.exp(logy));
          if (size + pend > MAX_POSTS) return MAX_POSTS;
        }
      }
      return size;
    };
  }

  // ------------------------------------------------------------------ stratified simulation
  const STRATA = [
    { kind: 'model', share: 0.34 },
    { kind: 'root', sf: 1e-2, share: 0.18 },      // roots in the most popular 1%
    { kind: 'root', sf: 2e-4, share: 0.18 },      // roots in the most popular 0.02%
    { kind: 'trait', shift: 2.6, share: 0.30 },   // persistent dialogues
  ];

  /* Runs `rounds` rounds of about `budget` simulated posts each. onRound receives cumulative sums:
     W[i*NB+k] (conversations), WS (posts), with i the size bin and k the root-reply bin, expressed
     per simulated conversation of the model; divide WS-W by itself to normalise per reply. */
  function simulate(P, opts, onRound) {
    const seed = opts.seed || 20261119, rounds = opts.rounds || 8, budget = opts.budget || 2.5e6;
    const ls = rootTable(P);
    const strata = STRATA.map((s) => Object.assign({}, s));
    for (const s of strata) if (s.kind === 'root') { s.x0 = xAtSf(ls, Math.log(s.sf)); s.logsf = Math.log(s.sf); }
    const draw = (s, rng) => {
      let x, theta = rng.n();
      if (s.kind === 'root') x = invRoot(ls, Math.log(rng.u()) + s.logsf);
      else x = invRoot(ls, Math.log(rng.u()));
      if (s.kind === 'trait') theta += s.shift;
      return [x, theta];
    };
    // pilot: mean simulated posts per conversation in each stratum
    const pilotRng = makeRng(seed ^ 0x9E3779B9), pilotSim = makeTreeSim(P, pilotRng);
    for (const s of strata) {
      let posts = 0; const n = s.kind === 'model' ? 4000 : 400;
      for (let i = 0; i < n; i++) { const [x, th] = draw(s, pilotRng); posts += pilotSim(Math.max(1, Math.floor(Math.exp(x))), th); }
      s.n = Math.max(200, Math.min(4e6, Math.round(budget * s.share / (posts / n))));
    }
    const W = new Float64Array(NB * NB), WS = new Float64Array(NB * NB);
    let excess = 0, trees = 0;
    const t0 = Date.now();
    for (let r = 0; r < rounds; r++) {
      const rng = makeRng(seed + 7919 * (r + 1)), sim = makeTreeSim(P, rng);
      for (const s of strata) {
        for (let i = 0; i < s.n; i++) {
          const [x, theta] = draw(s, rng);
          let den = 0;
          for (const q of strata) {
            if (q.kind === 'model') den += q.n;
            else if (q.kind === 'root') { if (x >= q.x0) den += q.n / q.sf; }
            else den += q.n * Math.exp(q.shift * theta - 0.5 * q.shift * q.shift);
          }
          const K = Math.max(1, Math.floor(Math.exp(x)));
          const S = sim(K, theta);
          if (S >= MAX_POSTS) excess += 1 / den;
          const cell = binOf(S) * NB + binOf(K), w = 1 / den;
          W[cell] += w; WS[cell] += w * S;
        }
        trees += s.n;
      }
      if (onRound) onRound({ round: r + 1, rounds, W, WS, trees, excess: excess / (r + 1), ms: Date.now() - t0 });
    }
    return { W, WS, rounds, trees, excess: excess / rounds };
  }

  /* Turn cumulative sums into a population table: conversations and posts per reply, by cell. */
  function normalise(W, WS) {
    let replies = 0;
    for (let c = 0; c < W.length; c++) replies += WS[c] - W[c];
    const w = new Float64Array(W.length), ws = new Float64Array(W.length);
    for (let c = 0; c < W.length; c++) { w[c] = W[c] / replies; ws[c] = WS[c] / replies; }
    return { w, ws };
  }

  const api = { EDGES, NB, binOf, simulate, normalise, logQ, zeta, rootTable, invRoot, DX, X_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GRT = api;

  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    root.onmessage = (ev) => {
      const { id, params, opts } = ev.data;
      simulate(params, opts || {}, (st) => {
        root.postMessage({ id, round: st.round, rounds: st.rounds, trees: st.trees, excess: st.excess, ms: st.ms,
                           W: st.W.slice(), WS: st.WS.slice() });
      });
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
