// Checks of the cascade arithmetic. Exits non-zero if any check fails.
// Expected values come from the archive's own summary (graphs/summary.txt, 30 daily files) or are recomputed
// from the rows, not from the model's own functions.
const C = require('../src/cascade_model.js');
let failed = 0;
const check = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + name + ': ' + (+(+got).toPrecision(6)) + ' (expected ' + (+(+want).toPrecision(6)) + ' +/- ' + (+(+tol).toPrecision(3)) + ')'); };
const yes = (name, cond) => check(name, cond ? 1 : 0, 1, 0);
const within = (name, got, want, rel) => check(name, got, want, Math.abs(want) * rel);
const D = C.DATA, M = 1e6;
const p7 = C.population({ window: 7 }), p3 = C.population({ window: 3 }), p2 = C.population({ window: 2 }), p1 = C.population({ window: 1 }), o7 = C.population({ window: 7, quoteRooted: false });

// the synthetic rows reproduce the archive's published thresholds table (per month = 30 days)
[[7, 100, 1410858, 677991658], [7, 1000, 122502, 339798392], [7, 5000, 12976, 125828770], [7, 10000, 3206, 60220247], [7, 20000, 671, 26189229],
 [3, 1000, 118372, 328938287], [3, 10000, 3069, 57648764], [3, 20000, 640, 25117117], [1, 1000, 99504, 262087990], [1, 10000, 2129, 41996967]].forEach(([w, s, n, posts]) => {
  const pop = C.population({ window: w, quoteRooted: false });
  within('cascades of ' + s + '+ in ' + w + ' days, original roots', pop.N(s), n, s >= 20000 ? 0.06 : 0.03);
  within('posts in them', pop.PO(s) / M, posts / M, s >= 20000 ? 0.04 : 0.02);
});
[[7, 1000, 17450, 44818531], [7, 10000, 315, 4662270], [3, 1000, 17321, 44478088], [3, 5000, 1668, 13639674]].forEach(([w, s, n, posts]) => {
  const pop = C.population({ window: w });
  within('quote-rooted cascades of ' + s + '+ in ' + w + ' days', pop.NQ(s), n, 0.04);
  within('posts in them', (pop.P(s) - pop.PO(s)) / M, posts / M, 0.03);
});
within('two days, cascades of 10,000+ (measured: 2,967)', C.population({ window: 2, quoteRooted: false }).N(10000), 2967, 0.03);
check('the facts carry the same totals', D.main.n100, 1410858, 0);
check('share of the 10,000+ that have passed 10,000 by 48 hours', D.passed10k[48], 0.925, 0.001);

// one population: counts, posts and parts are sums over the same rows
yes('counts and posts fall with size', (() => { for (let s = 100; s < 3e5; s *= 1.3) if (!(p7.N(s) >= p7.N(s * 1.3) && p7.P(s) > p7.P(s * 1.3) && p7.NQ(s) >= p7.NQ(s * 1.3))) return false; return true; })());
yes('a shorter window has fewer cascades and posts at every size', [100, 1000, 3000, 10000].every((s) => p1.NA(s) < p2.NA(s) && p2.NA(s) < p3.NA(s) && p3.NA(s) <= p7.NA(s) && p1.P(s) < p2.P(s) && p2.P(s) < p3.P(s) && p3.P(s) < p7.P(s)));
check('all roots are the two kinds together', p7.NA(5000), p7.N(5000) + p7.NQ(5000), 1e-9);
check('none rooted at a quote when they are not counted', o7.NQ(100) + o7.P(100) - o7.PO(100), 0, 0);
{ let tot = 0, rq = 0; for (const r of p3.rows) if (r.s >= 2750) { tot += r.w * r.s; rq += r.w * (r.rep + r.qt); }
  check('posts at 2,750+ recomputed from the rows', p3.P(2750), tot, 1);
  check('replies and quotes at 2,750+ recomputed from the rows', p3.RQ(2750), rq, 1);
  yes('replies and quotes are a part of the posts', p3.rows.every((r) => r.rep + r.qt <= r.s + 1e-9 && r.rep >= 0 && r.qt >= 0)); }
yes('replies and quotes are a smaller share of large cascades', p7.RQ(100) / p7.P(100) > p7.RQ(1000) / p7.P(1000) && p7.RQ(1000) / p7.P(1000) < 0.2 && p7.RQ(10000) / p7.P(10000) > 0.08);
check('three days keep about 98% of the seven-day posts', p3.share, 0.978, 0.004);
check('a month like June', C.population({ scale: D.months.June, window: 7 }).P(1000) / p7.P(1000), 710.3 / 825.9, 1e-9);
within('a 31-day month', C.population({ scale: 31 / 30, window: 3, quoteRooted: false }).N(10000), 3069 * 31 / 30, 0.03);

// reply-led cascades
check('reply-led share of posts, original roots, seven days', o7.LedPosts(100) / o7.P(100), D.replyLed.share_of_posts, 0.01);
{ const no = C.population({ window: 7, quoteRooted: false, replyLed: false });
  check('leaving them out removes exactly their posts', no.P(100), o7.P(100) - o7.LedPosts(100), 1);
  yes('they are rare above 10,000 posts and common between 1,000 and 10,000', o7.LedPosts(10000) / o7.P(10000) < 0.08 && (o7.LedPosts(1000) - o7.LedPosts(10000)) / (o7.P(1000) - o7.P(10000)) > 0.2); }

// size read from a root's counts
check('a root with many retweets: its counts are the cascade', C.fromCounts(5000, 300, 200), 5500, 1e-9);
check('a root with replies and few retweets: replies stand for hidden retweets', C.fromCounts(10, 200, 0), 210 + D.rule.kB * 200, 1e-9);

// the plan, every cascade taken as found: costs are sums of the measured parts
const base = { full: 10000, rq: 2750, passes: 3, fr: 1000, fd: 100, triage: 'counts', theta: 0.5, rtMode: 'none', rtN: 100, rtRate: 0.03, stream: 0.01 };
const but = (o) => Object.assign({}, base, o);
{ const r = C.plan(p3, but({ found: 'all' }));
  check('tier 1 costs every post', r.cost1, p3.P(10000), 1);
  check('tier 1 parts add up', (r.t1.replies + r.t1.quotes + r.t1.retweets) / r.A, 1, 1e-9);
  check('tier 2 costs the replies and quotes between 2,750 and 10,000', r.cost2, p3.RQ(2750) - p3.RQ(10000), 1);
  check('nothing spent on finding or sizing', r.finding + r.waste + r.roots, 0, 0);
  check('everything wanted is found', r.found, 1, 1e-9);
  within('cascades in tier 1, original roots', r.n1, 3069, 0.03);
  check('retweets of tier 2 seen in the 1% stream', r.streamRetweets, 0.01 * r.t2.allRetweets, 1);
  check('first N with N above every size is every retweet', C.plan(p3, but({ found: 'all', rtMode: 'first', rtN: 1e9 })).bought / r.t2.allRetweets, 1, 1e-9);
  yes('the first 100 retweets of each cost at most 100 a cascade', C.plan(p3, but({ found: 'all', rtMode: 'first' })).bought <= 100 * (r.n2 + r.q2) + 1);
  check('a 3% bought sample of tier 2 retweets', C.plan(p3, but({ found: 'all', rtMode: 'sample' })).bought, 0.03 * r.t2.allRetweets, 1);
  const open = C.plan(p3, but({ found: 'all', full: Infinity, rq: 1000 }));
  check('no cascade in full: tier 1 is empty', open.cost1 + open.n1 + open.q1, 0, 0);
  check('replies and quotes from 1,000', open.cost2, p3.RQ(1000), 1); }

// finding and sizing
{ const r = C.plan(p3, base), all = C.plan(p3, but({ triage: 'all' })), st = C.plan(p3, but({ triage: 'stream' })), ideal = C.plan(p3, but({ found: 'all' }));
  let roots = 0; for (const x of p3.rows) if (x.r0 >= 1000 || x.d0 >= 100) roots += x.w;
  check('roots returned: every root passing either floor', r.roots, roots, 1e-6);
  check('each pass is charged', r.finding, 3 * roots, 1e-6);
  check('no passes cost nothing', C.plan(p3, but({ passes: 0 })).finding, 0, 0);
  yes('reading every candidate\'s replies finds the most and costs the most', all.found >= r.found && all.total > r.total && all.waste > r.waste);
  yes('reading every candidate\'s replies breaks a 100M cap; screening by counts does not', all.total > 100e6 && r.total < 95e6);
  yes('search with these floors returns nearly every cascade of 2,750+', all.found2 > 0.98 && all.found1 > 0.995);
  yes('screening by root counts keeps nearly all of tier 1 and most of tier 2', r.found1 > 0.98 && r.found2 > 0.8 && r.found2 < 0.95);
  yes('screening by the 1% stream keeps more of tier 2 for about the same units', st.found2 > r.found2 && Math.abs(st.total - r.total) < 5e6);
  yes('no plan finds more than the ideal collects', r.cost1 <= ideal.cost1 + 1 && r.cost2 <= ideal.cost2 + 1 && all.cost2 <= ideal.cost2 + 1);
  check('what is found is charged: tier 2 cost is the replies and quotes of the cascades found', r.cost2, r.t2.replies + r.t2.quotes, 1e-6);
  const noReply = C.plan(p3, but({ fd: Infinity }));
  yes('without a floor on replies a third of tier 2 is never returned', noReply.found2 < 0.75 && noReply.found1 > 0.95);
  const lower = C.plan(p3, but({ theta: 0.3 }));
  yes('a lower bar for reading replies finds more and wastes more', lower.found2 > r.found2 && lower.waste > r.waste);
  const no = C.population({ window: 3, replyLed: false }), rn = C.plan(no, base);
  yes('with reply-led cascades left out, nearly all of tier 2 is found and the plan costs less', rn.found2 > 0.98 && rn.total < r.total);
  check('they are still returned by search', rn.roots, r.roots, 1e-6);
  // the page's opening plan: reply-led left out, a floor of 500 retweets on the root, no floor on replies
  const od = but({ fr: 500, fd: Infinity }), eo = C.lowest(no, od, 'rq', 90e6, 100, 10000), ro = C.plan(no, Object.assign({}, od, { rq: eo }));
  yes('left out and searched by retweets alone, the second tier reaches below 1,000 posts under 90M', eo > 600 && eo < 1000);
  yes('and search finds nearly all of both tiers', ro.found2 > 0.95 && ro.found1 > 0.995);
  yes('with less spent on cascades too small than the plan that counts them', ro.waste < 0.3 * r.waste); }

// a sample of the reply-led cascades
{ const all = C.population({ window: 3 }), none = C.population({ window: 3, replyLed: false }), tenth = C.population({ window: 3, replyLed: 0.1 });
  check('a 10% sample holds a tenth of the reply-led posts', tenth.LedPosts(100), 0.1 * all.LedPosts(100), 1e-6 * all.LedPosts(100));
  check('and every other cascade', tenth.P(100) - tenth.LedPosts(100), none.P(100), 1e-6 * none.P(100));
  yes('a share of 0 is the same as leaving them out, a share of 1 the same as counting them', C.population({ window: 3, replyLed: 0 }).P(100) === none.P(100) && C.population({ window: 3, replyLed: 1 }).P(100) === all.P(100));
  const o = { full: 10000, rq: 1000, passes: 3, fr: 500, fd: 100, triage: 'counts', theta: 0.5, rtMode: 'none', stream: 0.01 };
  const ra = C.plan(all, o), rn = C.plan(none, o), rt = C.plan(tenth, o);
  check('search returns the same roots whatever the share', rt.roots, ra.roots, 1e-6);
  const r0 = C.plan(none, Object.assign({}, o, { fd: Infinity }));
  yes('a sample costs more than leaving them out and searching by retweets alone, and much less than taking them all', rt.total > r0.total && rt.total < r0.total + 0.3 * (ra.total - r0.total));
  yes('roots found by their replies alone are read only when sampled: less is spent on cascades too small than with none left out', rt.waste < rn.waste);
  // the page's opening plan: a random 2%, floors of 500 retweets or 100 replies
  const two = C.population({ window: 3, replyLed: 0.02 }), eo = C.lowest(two, o, 'rq', 90e6, 100, 10000), ro = C.plan(two, Object.assign({}, o, { rq: eo }));
  yes('with a 2% sample the second tier starts between 900 and 1,200 posts under 90M', eo > 900 && eo < 1200);
  yes('and search finds nearly all of both tiers', ro.found2 > 0.95 && ro.found1 > 0.995); }

// prize draws
{ const all = C.population({ window: 3, replyLed: false }), none = C.population({ window: 3, replyLed: false, prize: 0 }), two = C.population({ window: 3, replyLed: false, prize: 0.02 });
  check('prize draws hold about 63% of the posts in original-root cascades of 10,000+ that are not reply-led', all.PrizePosts(10000) / all.PO(10000), 0.61, 0.04);
  check('left out, their posts are gone from every count', all.P(100) - none.P(100), all.PrizePosts(100), 1e-6 * all.P(100));
  check('a 2% sample holds 2% of their posts', two.PrizePosts(100), 0.02 * all.PrizePosts(100), 1e-6 * all.PrizePosts(100));
  yes('leaving the option out counts every prize draw', C.population({ window: 3, replyLed: false, prize: 1 }).P(100) === all.P(100) && none.PrizePosts(100) === 0);
  const o = { full: 10000, rq: 300, passes: 3, fr: 300, fd: Infinity, triage: 'counts', theta: 0.5, rtMode: 'none', stream: 0.01 };
  const ra = C.plan(all, o), rn = C.plan(none, o);
  check('search returns the same roots with prize draws left out', rn.roots, ra.roots, 1e-6);
  yes('without prize draws the cascades in full cost less than half as much', rn.cost1 < 0.5 * ra.cost1 && rn.cost1 > 0.3 * ra.cost1);
  // the page's opening plan until the eighth version: a random 2% of reply-led cascades and of prize draws, floors of 300 retweets or 100 replies, second tier from 300 posts
  const open = C.population({ window: 3, replyLed: 0.02, prize: 0.02 }), oo = Object.assign({}, o, { fd: 100 }), ro = C.plan(open, oo), rin = C.plan(C.population({ window: 3, replyLed: 0.02 }), oo);
  yes('the earlier opening plan reaches 300 posts for 55M to 70M units, with at least 80% of the second tier found', ro.total > 55e6 && ro.total < 70e6 && ro.found2 >= 0.8);
  yes('the same reach with every prize draw collected is over the cap', rin.total > 100e6); }

// a cascade whose size sits on its replies: the root's retweet count does not find it
{ const rows = [{ w: 1, s: 9, q: 0, led: 1, rep: 2, qt: 0, r0: 0, d0: 2, q0: 0 }, { w: 1, s: 9, q: 0, led: 0, rep: 1, qt: 1, r0: 7, d0: 1, q0: 1 }];
  const pop = C.build(rows, {}), o = { full: Infinity, rq: 9, passes: 1, theta: 1, triage: 'all', rtMode: 'none' };
  check('a floor of 7 retweets on the root returns one of the two', C.plan(pop, Object.assign({ fr: 7, fd: Infinity }, o)).roots, 1, 0);
  check('and finds half', C.plan(pop, Object.assign({ fr: 7, fd: Infinity }, o)).found, 0.5, 1e-9);
  check('a floor of 2 replies returns the other', C.plan(pop, Object.assign({ fr: Infinity, fd: 2 }, o)).found, 0.5, 1e-9);
  check('either floor returns both', C.plan(pop, Object.assign({ fr: 7, fd: 2 }, o)).found, 1, 1e-9);
  const small = C.build([{ w: 1, s: 6, q: 0, led: 0, rep: 5, qt: 0, r0: 1, d0: 5, q0: 0 }], {});
  check('replies read for a cascade below the tier are spent', C.plan(small, Object.assign({ fr: 1, fd: Infinity }, o)).waste, 5, 0);
  check('and it is not collected', C.plan(small, Object.assign({ fr: 1, fd: Infinity }, o)).cost2, 0, 0); }

// lowest second-tier size that fits (10M reserve)
{ const e = C.lowest(p3, base, 'rq', 90e6, 100, 10000);
  yes('the second tier reaches between 2,000 and 3,200 posts under 90M', e > 2000 && e < 3200);
  yes('at the edge the plan is within budget', C.plan(p3, but({ rq: e })).total <= 90e6 + 1);
  yes('just below the edge it is not', C.plan(p3, but({ rq: e * 0.97 })).total > 90e6);
  yes('with every cascade found at no cost it reaches lower', C.lowest(p3, but({ found: 'all' }), 'rq', 90e6, 100, 10000) < e);
  yes('a one-day window lets the second tier reach lower still', C.lowest(p1, but({ passes: 1 }), 'rq', 90e6, 100, 10000) < e);
  yes('nothing fits when tier 1 alone is over budget', C.lowest(p3, base, 'rq', 50e6, 100, 10000) === null);
  yes('no budget, no answer', C.lowest(p3, base, 'rq', 0, 100, 10000) === null && C.lowest(p3, base, 'rq', NaN, 100, 10000) === null && C.lowest(p3, base, 'rq', -5, 100, 10000) === null);
  const g = C.lowest(p3, but({ rq: Infinity, found: 'all' }), 'full', 90e6, 1000, Infinity);
  yes('every post and no second tier fits from between 5,000 and 9,000 posts', g > 5000 && g < 9000);
  yes('an open upper limit still gives an answer however small the budget', C.lowest(p3, but({ rq: Infinity, found: 'all' }), 'full', 1000, 1000, Infinity) > 1e5); }

// found by size
{ const f = C.foundBySize(p3, base, [100, 1000, 2750, 10000, 1e9]);
  yes('found share rises with size and is given for every band', f.length === 4 && f.every((b) => b.found != null) && f[3].found > f[2].found && f[2].found > f[1].found && f[1].found > f[0].found);
  yes('bands below the bar for sizing are mostly not sized', f[0].found < 0.05); }

// recognising reply-led roots from their counts, one draw for each root, and what the sample can reach
{ const o = { full: 10000, rq: 300, passes: 3, fr: 300, fd: 100, triage: 'counts', theta: 0.5, rtMode: 'none', stream: 0.01 };
  const row = (x) => Object.assign({ w: 100, s: 1000, q: 0, led: 0, prize: 0, out: 0, rep: 400, qt: 0, r0: 400, d0: 100, q0: 0 }, x);
  const mk = (rows, share) => { const p = C.build(rows, { replyLed: share > 0 }); p.ledShare = share; return p; };
  const both = (rows, share) => ['class', 'counts'].map((recog) => C.plan(mk(rows.map((x) => Object.assign({}, x)), share), Object.assign({}, o, { recog })));
  // an ordinary root that looks reply-led (more than five replies for each retweet) and passes the floor on retweets
  let [a, b] = both([row({ r0: 400, d0: 2500, rep: 2600, s: 4000 })], 0.02);
  check('taken as known, an ordinary root that looks reply-led is read', a.n2, 100, 1e-9);
  check('by counts it is read only if it is in the sample', b.n2, 2, 1e-9);
  check('and the rest are counted as wanted cascades lost', b.lost, 98, 1e-9);
  check('it stays in the count of cascades wanted', b.want2, 100, 0);
  check('search charges for it either way', b.finding - a.finding, 0, 0);
  // the part of a reply-led group that is left out, with a root that does not look reply-led and passes the floor on retweets
  [a, b] = both([row({ led: 1, out: 1, r0: 400, d0: 500, rep: 600, s: 3000 })], 0.02);
  check('taken as known, a reply-led root left out costs nothing to read', a.waste, 0, 0);
  check('by counts, one that does not look reply-led has its replies read first', b.waste, 100 * 600, 1e-6);
  check('those units are reported apart', b.strayUnits, 100 * 600, 1e-6);
  yes('and it is still not collected or wanted', b.n2 === 0 && b.want2 === 0 && b.cost2 === 0);
  [a, b] = both([row({ led: 1, out: 1, r0: 400, d0: 2500, rep: 2600, s: 9000 })], 0.02);
  check('one that looks reply-led is set aside unread', b.waste, 0, 0);
  [a, b] = both([row({ led: 1, out: 1, r0: 50, d0: 200, rep: 300, s: 1200 })], 0.02);
  check('so is one returned for its replies alone, whatever it looks like', b.waste, 0, 0);
  // one draw for each root: a prize draw that is kept is read whichever floor returned it
  [a, b] = both([row({ prize: 1, r0: 100, d0: 300, rep: 350, s: 1000 })], 0.02);
  check('as the page had it, a kept prize draw found by its replies alone was drawn again', a.n2, 2, 1e-9);
  check('with one draw for each root it is read', b.n2, 100, 1e-9);
  // a kept reply-led row is read at its full weight in both
  [a, b] = both([row({ led: 1, r0: 400, d0: 500, rep: 600, s: 3000 })], 0.02);
  yes('the sampled part of a reply-led group is read in full either way', a.n2 === 100 && b.n2 === 100);
  // nothing changes where no root looks reply-led and every root passes the floor on retweets
  [a, b] = both([row({}), row({ s: 20000, r0: 15000, d0: 500, rep: 800 })], 0.02);
  check('ordinary roots found by their retweets cost the same', b.total - a.total, 0, 1e-9);
  // reach: a class of which a quarter is returned by search
  const cls = mk([row({ led: 1, w: 2, r0: 10, d0: 150, rep: 200, s: 1000 }), row({ led: 1, out: 1, w: 98, r0: 10, d0: 150, rep: 200, s: 1000 }),
                  row({ led: 1, w: 6, r0: 10, d0: 60, rep: 80, s: 500 }), row({ led: 1, out: 1, w: 294, r0: 10, d0: 60, rep: 80, s: 500 })], 0.02);
  const rc = C.reach(cls, o, 'led', [300, 1e9])[0];
  check('reach counts the whole class, kept or not', rc.n, 400, 1e-9);
  check('a quarter of it is returned by search', rc.returned, 0.25, 1e-9);
  check('so a 2% sample is 0.5% of the class', 0.02 * rc.read, 0.005, 1e-9);
  check('an unreachable reply-led root costs nothing to search, size or collect', C.plan(mk([row({ led: 1, out: 1, r0: 10, d0: 60, rep: 80, s: 500 })], 0.02), Object.assign({}, o, { recog: 'counts' })).total, 0, 0);
  // on the September population
  const pop = C.population({ window: 3, replyLed: 0.02, prize: 0.02 });
  const pc = C.plan(pop, Object.assign({}, o, { recog: 'class' })), pk = C.plan(pop, Object.assign({}, o, { recog: 'counts' }));
  within('the seventh version’s opening plan with reply-led roots taken as known (62.91M on the rows before it)', pc.total / M, 62.34, 0.002);
  within('and with reply-led roots recognised from counts', pk.total / M, 62.88, 0.002);
  { const T = C.TABLES.rows; let ro = 0, fo = 0; for (let i = 0; i < T.w.length; i++) { if (T.q[i] || T.led[i]) continue; const f = T.s3[i] / T.s7[i], r0 = T.r0[i] * f, d0 = T.d0[i] * f; if (r0 >= 300 || d0 >= 100) { ro += T.w[i]; if (d0 > 5 * r0) fo += T.w[i]; } }
    yes('ordinary roots wrongly flagged as reply-led: 4 to 7% of those returned (measured 4.3% and 4.6%)', fo / ro > 0.04 && fo / ro < 0.07); }
  yes('with no recog option the plan is that one', C.plan(pop, o).total === pc.total);
  yes('recognising them from counts costs more, by under 1M on these rows', pk.total > pc.total && pk.total - pc.total < 1e6);
  yes('and finds within half a point as much of the second tier', Math.abs(pk.found2 - pc.found2) < 0.005);
  yes('search returns the same roots', pk.roots === pc.roots);
  const E = [300, 1000, 3000, 1e9], fb = C.foundBySize(pop, Object.assign({}, o, { recog: 'counts' }), E);
  within('found by size and the plan agree on the cascades read from 300 posts up', fb.reduce((t, x) => t + x.n * x.found, 0), pk.n1 + pk.q1 + pk.n2 + pk.q2, 1e-9);
  const rl = C.reach(pop, o, 'led', [100, 300, 1000, 3000, 1e9]), rAll = C.reach(pop, o, 'led', [100, 1e9])[0];
  check('search returns about a quarter of all reply-led cascades (measured: 24.8% and 25.1%)', rAll.returned, 0.25, 0.02);
  yes('reach rises with size and is complete from 3,000 posts', rl[0].returned < rl[1].returned && rl[1].returned < rl[2].returned && rl[3].returned > 0.99);
  within('reach counts the class whatever share is kept', C.reach(C.population({ window: 3, replyLed: 0.2, prize: 0.02 }), o, 'led', [100, 1e9])[0].n, rAll.n, 1e-9);
  within('found by size gives the same reply-led reach', (() => { const f = C.foundBySize(pop, o, [100, 1e9])[0]; return f.ledReturned; })(), rAll.returned, 1e-9);
  yes('prize draws of 1,000+ are all within reach', C.reach(pop, o, 'prize', [1000, 1e9])[0].read > 0.99); }

// the page's opening plan: second tier down to 100 posts, floors of 100 retweets or 100 replies (since the eighth version); 2% of prize draws (20% in the eighth version, 2% again since the ninth)
{ const M = 1e6, o = { full: 10000, rq: 100, passes: 3, fr: 100, fd: 100, triage: 'counts', theta: 0.5, rtMode: 'none', stream: 0.01, recog: 'counts' };
  const pop = C.population({ window: 3, replyLed: 0.02, prize: 0.02 }), r = C.plan(pop, o), r20 = C.plan(C.population({ window: 3, replyLed: 0.02, prize: 0.2 }), o);
  within('the opening plan: down to 100 posts, with 2% of prize draws', r.total / M, 82.50, 0.002);
  within('the same plan with 20% of prize draws (the eighth version) is the largest share offered that fits', r20.total / M, 89.66, 0.002);
  yes('with 2% of prize draws the first tier could reach 8,000 to 8,600 posts with the second tier still at 100', (() => { const f = C.lowest(pop, o, 'full', 90e6, 1000, 1e6); return f > 8000 && f < 8600; })());
  yes('it fits the 90M left after a reserve of 10M', r.total <= 90e6);
  yes('100 posts is the lowest second tier that fits', C.lowest(pop, o, 'rq', 90e6, 100, 10000) <= 100.5);
  yes('half of the prize draws would not fit', C.plan(C.population({ window: 3, replyLed: 0.02, prize: 0.5 }), o).total > 90e6);
  yes('search finds 75% to 80% of the second tier', r.found2 > 0.75 && r.found2 < 0.8);
  const b = C.foundBySize(pop, o, [100, 300, 1000, 1e12]);
  yes('68% of cascades of 100 to 299 posts are found, 97% of 300 to 999', Math.abs(b[0].found - 0.68) < 0.02 && Math.abs(b[1].found - 0.97) < 0.02);
  check('search still returns about a quarter of all reply-led cascades (measured at these floors: 25.5% and 25.7%)', C.reach(pop, o, 'led', [100, 1e9])[0].returned, 0.256, 0.02); }

check('1% stream sees a 100-post cascade', C.binomSf(1, 100, 0.01), 0.634, 0.001);
check('at least no sampled posts is certain', C.binomSf(0, 100, 0.01), 1, 0);
console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nall checks passed');
process.exit(failed ? 1 : 0);
