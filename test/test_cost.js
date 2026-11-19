// Compare the cost engine with the explainer's numbers (results.txt), using the reference tables.
const G = require('../src/sim.js'), C = require('../src/cost.js'), REF = require('../src/ref_tables.js');
const E = G.EDGES;
const fmt = (p) => p ? `${p.family} T=${p.T || '-'} h=${p.h || '-'} p=${p.p ? p.p.toPrecision(4) : '-'} ${p.count ? 'count' : 'no count'} cost ${(100 * p.cost).toFixed(3)}% recall ${(100 * p.recall).toFixed(1)}% [find ${(100 * p.finding).toFixed(3)} count ${(100 * p.counting).toFixed(3)} read ${(100 * p.reading).toFixed(3)} waste ${(100 * p.wasted).toFixed(3)}]` : 'none';
for (const [name, cutsToShow] of [['japan2011', [50, 100, 200, 300]], ['usArchives', [100, 1000, 5000]]]) {
  const t = C.fromCells(REF[name].cells); let t0 = Date.now();
  const pop = C.buildPop(t.w, t.ws); const tb = Date.now() - t0; t0 = Date.now();
  const ev = C.evaluate(pop, {}, { recall: 0.9, budget: 1e9, cutSel: E.indexOf(100), stream: { mode: 'buy' } });
  console.log(`\n== ${name}: build ${tb}ms, evaluate ${Date.now() - t0}ms, conversations per M ${(1e6 * pop.conv).toFixed(0)}`);
  for (const s of cutsToShow) {
    const r = ev.byCut.find((x) => x.size === s);
    console.log(` S>=${s} tier ${(1e6 * r.tierW).toFixed(1)}/M, volume ${(100 * r.tierPosts).toFixed(3)}%`);
    for (const f of ['root', 'sample', 'both']) console.log('   ', fmt(r.families[f].atFloor));
  }
  const r100 = ev.byCut.find((x) => x.size === 100);
  const cov = C.coverage(pop, r100.atFloor);
  console.log(' coverage of best at 100:', Object.fromEntries(Object.entries(cov).filter(([k]) => !['incl', 'weight'].includes(k)).map(([k, v]) => [k, v == null ? v : +v.toFixed(3)])));
  for (const b of [0.01, 0.03, 0.1, 0.3]) {
    const e2 = C.evaluate(pop, {}, { recall: 0.9, budget: b, cutSel: E.indexOf(100), stream: { mode: 'buy' } });
    const ok = e2.byCut.filter((x) => x.atFloor && x.atFloor.cost <= b);
    console.log(` budget ${100 * b}% -> smallest cutoff ${ok.length ? ok[0].size : 'none'}`);
  }
  if (name === 'japan2011') {
    const rootOnly = C.evaluate(pop, {}, { recall: 0.6, budget: 1, cutSel: E.indexOf(100), allowSample: false }).byCut.find((x) => x.size === 100);
    console.log(' root only, floor 60%:', fmt(rootOnly.families.root.atFloor));
    for (const p of [0.01, 0.1, 1]) {
      const fs = C.evaluate(pop, {}, { recall: 0.7, budget: 1, cutSel: E.indexOf(100), stream: { mode: 'free', p } }).byCut.find((x) => x.size === 100);
      console.log(` free ${100 * p}% stream:`, fmt(fs.atFloor), '| in budget:', fmt(fs.inBudget));
    }
    const d = C.evaluate(C.buildPop(t.w, t.ws, { descendants: true }), {}, { recall: 0.9, budget: 1, cutSel: E.indexOf(100) }).byCut.find((x) => x.size === 100);
    console.log(' min_replies counts all descendants:', fmt(d.atFloor));
    console.log(' frontier sizes', Object.fromEntries(Object.entries(ev.frontier).map(([k, v]) => [k, v.length])));
  }
}
