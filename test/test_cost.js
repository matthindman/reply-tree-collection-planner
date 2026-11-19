// Checks of the cost engine. Exits non-zero if any check fails.
// Reference values: ../collection_strategy_2026_11_19/results.txt (Python cost model) and hand-worked fixtures.
const G = require('../src/sim.js'), C = require('../src/cost.js'), REF = require('../src/ref_tables.js'), SC = require('../src/scenario_tables.js');
const E = G.EDGES, NB = G.NB;
let failed = 0;
const check = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + name + ': ' + (+got.toPrecision(5)) + ' (expected ' + want + ' +/- ' + tol + ')'); };
const truth = (name, cond, detail) => { if (!cond) failed++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail ? ': ' + detail : '')); };
const popOf = (t, opts) => C.buildPop(t.w, t.ws, Object.assign({ wq: t.wq }, opts || {}));
const at = (ev, size) => ev.byCut.find((x) => x.size === size);
const J100 = E.indexOf(100);

// ---- Japan 2011 reference population against the Python cost model
{
  const pop = popOf(C.fromCells(REF.japan2011.cells));
  const ev = C.evaluate(pop, {}, { recall: 0.9, budget: 10, cutSel: J100, stream: { mode: 'buy' } }), r = at(ev, 100);
  check('Japan 2011: conversations per million replies', 1e6 * pop.conv, 315314, 50);
  check('Japan 2011: share of posts in 100+ conversations', r.tierPosts, 0.002706, 0.00002);
  check('Japan 2011: reply sample alone, 90% of 100+ (Python 3.86%)', 100 * r.families.sample.atFloor.cost, 3.83, 0.12);
  check('Japan 2011: root search plus sample, 90% of 100+ (Python 2.67%)', 100 * r.families.both.atFloor.cost, 2.62, 0.1);
  check('Japan 2011: root search at 50 finds (Python 60.7%)', 100 * C.rootPolicy(pop, {}, J100, 50, true).recall, 60.7, 0.3);
  check('Japan 2011: root search at 50 costs (Python 0.2035%)', 100 * C.rootPolicy(pop, {}, J100, 50, true).cost, 0.2035, 0.003);
  for (const [b, want] of [[0.01, 200], [0.03, 100], [0.1, 50], [0.3, 20]]) {
    const e2 = C.evaluate(pop, {}, { recall: 0.9, budget: b, cutSel: J100, stream: { mode: 'buy' } });
    const ok = e2.byCut.filter((x) => x.atFloor && x.atFloor.cost <= b);
    check('Japan 2011: smallest size at a budget of ' + 100 * b + '%', ok.length ? ok[0].size : NaN, want, 0);
  }
  truth('Japan 2011: every recall is between 0 and 1', ev.byCut.every((x) => ['root', 'sample', 'both'].every((f) => ['atFloor', 'inBudget'].every((k) => !x.families[f][k] || (x.families[f][k].recall >= 0 && x.families[f][k].recall <= 1 + 1e-9)))));
  // full stream outside the quota: everything is found and only the roots are fetched
  const fs = at(C.evaluate(pop, {}, { recall: 0.9, budget: 1, cutSel: J100, allowRoot: false, stream: { mode: 'free', p: 1 } }), 100).families.sample.inBudget;
  check('Japan 2011: full free stream finds', fs.recall, 1, 1e-9);
  check('Japan 2011: full free stream costs one unit per conversation', fs.cost / at(ev, 100).tierW, 1, 1e-9);
  // a fixed 1% stream cannot find 90%: that is a ceiling, not a budget problem
  const c1 = at(C.evaluate(pop, {}, { recall: 0.9, budget: 2, cutSel: J100, allowRoot: false, stream: { mode: 'free', p: 0.01 } }), 100);
  truth('Japan 2011: a free 1% stream alone has no plan that finds 90%', !c1.families.sample.atFloor, 'most it finds: ' + (100 * c1.families.sample.inBudget.recall).toFixed(1) + '%');
}
// ---- US archives
{
  const pop = popOf(C.fromCells(REF.usArchives.cells)), r = at(C.evaluate(pop, {}, { recall: 0.9, budget: 10, cutSel: J100, stream: { mode: 'buy' } }), 100);
  // The Python model costs whole plans (82.18%, finding 97%). Keeping only enough candidates to find exactly 90% is cheaper.
  check('US archives: cheapest plan for exactly 90% of 100+', 100 * r.atFloor.cost, 76.9, 0.5);
  truth('US archives: that plan is cheaper than the whole-plan figure of 82.18%', 100 * r.atFloor.cost < 82.18);
  check('US archives: quiet-root share of 100+ conversations (exact 15.2%)', 100 * pop.tierQuiet[J100] / pop.tierW[J100], 15.22, 0.05);
}
// ---- best guess at the page's defaults (500M replies, 50M units)
{
  const pop = popOf(C.fromCells(SC.today.cells)), b = 50e6 / 500e6;
  const r = at(C.evaluate(pop, {}, { recall: 0.9, budget: b, cutSel: J100, stream: { mode: 'buy' } }), 100);
  check('Best guess: 100+ conversations a month', r.tierW * 500e6, 221530, 300);
  truth('Best guess: finding 90% costs no more than a whole plan would (60.32M units)', r.atFloor.cost * 500e6 <= 60.33e6, (r.atFloor.cost * 500e6 / 1e6).toFixed(2) + 'M units');
  truth('Best guess: within the quota, partial admission finds at least 74.6%', r.inBudget.recall >= 0.746, (100 * r.inBudget.recall).toFixed(2) + '% with ' + (100 * r.inBudget.admit).toFixed(1) + '% of candidates kept, root threshold ' + r.inBudget.T);
  check('Best guess: the in-budget plan spends the quota', r.inBudget.cost, b, 1e-9);
  const cov = C.coverage(pop, r.inBudget);
  check('Best guess: coverage agrees with the plan\'s recall', (cov.foundQuiet * pop.tierQuiet[J100] + cov.foundDriven * (pop.tierW[J100] - pop.tierQuiet[J100])) / pop.tierW[J100], r.inBudget.recall, 1e-6);
  check('Best guess: quiet-root share of 100+ conversations (exact 22.9%)', 100 * pop.tierQuiet[J100] / pop.tierW[J100], 22.9, 0.2);
}
// ---- fixtures worked by hand
{
  // one conversation of 2 posts and one of 100, each with one direct reply; count 20, request fee 50, root billed 2 days
  const w = new Float64Array(NB * NB), ws = new Float64Array(NB * NB);
  w[E.indexOf(2) * NB + 0] = 0.01; ws[E.indexOf(2) * NB + 0] = 0.02; w[J100 * NB + 0] = 0.01; ws[J100 * NB + 0] = 1.0;
  const pop = C.buildPop(w, ws), pr = { count: 20, requestFee: 50, rootDays: 2 };
  check('Fixture: fetching without a count pays the request for the conversation it discards', C.rootPolicy(pop, pr, J100, 1, false).cost, 2.062, 1e-9);
  check('Fixture: counting first', C.rootPolicy(pop, pr, J100, 1, true).cost, 1.942, 1e-9);
  const r = at(C.evaluate(pop, pr, { recall: 0.9, budget: 10, cutSel: J100, allowSample: false }), 100).families.root.atFloor;
  truth('Fixture: the engine prefers counting first', r.count === true && Math.abs(r.cost - 0.9 * 1.9 - 0.042) < 1e-9, 'cost ' + r.cost.toFixed(4) + ' with ' + (100 * r.admit).toFixed(0) + '% kept');
}
{
  // equal numbers of 100-post and 124-post conversations in one size bin: needing 100 sampled replies of a full sample finds half
  const w = new Float64Array(NB * NB), ws = new Float64Array(NB * NB); w[J100 * NB + 0] = 2; ws[J100 * NB + 0] = 224;
  const pop = C.buildPop(w, ws), off = (C.H_GRID.indexOf(100) * C.P_GRID.length + C.P_GRID.length - 1) * NB;
  check('Fixture: detection is taken at the ends of a size bin, not its mean', pop.det[off + J100], 0.5, 1e-6);
  truth('Fixture: a size no conversation reaches is not offered', C.buildPop(w, ws).cuts.every((j) => E[j] <= 100));
}
console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nall checks passed');
process.exit(failed ? 1 : 0);
