"""Synthetic post records with known answers, for testing the intake path.

Trees come from the G18 generator; times, authors and ids are invented. A
declared number of defects is injected so that the ledger can be checked
against known counts. This says nothing about real data.
"""

import numpy as np

from . import g18_sim


def make_records(P, n_trees, seed, cohort_start=0.0, cohort_end=30 * 86400.0, mean_delay=3600.0,
                 n_zero_reply_roots=0, n_roots_before_cohort=0, n_duplicates=0, n_deleted_replies=0,
                 n_missing_root_records=0):
    """Return (records, truth). records is a shuffled list of 5-tuples.

    truth maps root_id -> dict(parents, times, authors) for every generated
    conversation, before defects, with posts in generation order.
    """
    rng = np.random.default_rng(seed)
    out = g18_sim.simulate_chunk(P, n_trees, rng, explicit=True)
    off, par = out["offsets"], out["parents"]
    records, truth = [], {}
    n = len(off) - 1
    before = set(rng.choice(n, size=n_roots_before_cohort, replace=False).tolist()) if n_roots_before_cohort else set()
    for i in range(n):
        p = par[off[i]:off[i + 1]]
        m = len(p)
        t0 = (cohort_start - rng.uniform(1, 86400)) if i in before else rng.uniform(cohort_start, cohort_end)
        times = np.empty(m); times[0] = t0
        authors = np.empty(m, dtype=np.int64); authors[0] = 0
        pool = max(2, int(rng.integers(2, 6)))
        for j in range(1, m):
            times[j] = times[p[j]] + rng.exponential(mean_delay) + 1.0
            # alternate with the grandparent's author half of the time (a two-person exchange)
            gp = p[p[j]] if p[j] > 0 else -1
            authors[j] = authors[gp] if gp >= 0 and rng.random() < 0.5 else int(rng.integers(1, pool))
            if authors[j] == authors[p[j]]:
                authors[j] = (authors[j] + 1) % pool
        root_id = f"c{i}"
        ids = [root_id] + [f"c{i}_{j}" for j in range(1, m)]
        truth[root_id] = dict(parents=p.tolist(), times=(times - t0).tolist(), ids=ids, root_time=float(t0),
                              authors=[f"u{i}_{a}" for a in authors])
        for j in range(m):
            records.append((ids[j], "" if j == 0 else ids[p[j]], root_id, float(times[j]), f"u{i}_{authors[j]}"))
    for z in range(n_zero_reply_roots):
        rid = f"z{z}"
        records.append((rid, "", rid, float(rng.uniform(cohort_start, cohort_end)), f"uz{z}"))
    info = dict(deleted=[], missing_root=[], duplicated=[])
    reply_idx = [k for k, r in enumerate(records) if r[1] != ""]
    drop = set()
    if n_deleted_replies:
        drop |= set(rng.choice(reply_idx, size=n_deleted_replies, replace=False).tolist())
        info["deleted"] = [records[k][0] for k in sorted(drop)]
    if n_missing_root_records:
        roots = [k for k, r in enumerate(records) if r[1] == "" and r[0].startswith("c")]
        gone = rng.choice(roots, size=n_missing_root_records, replace=False).tolist()
        info["missing_root"] = [records[k][0] for k in gone]
        drop |= set(gone)
    kept = [r for k, r in enumerate(records) if k not in drop]
    if n_duplicates:
        dup = rng.choice(len(kept), size=n_duplicates, replace=False).tolist()
        info["duplicated"] = [kept[k][0] for k in dup]
        kept += [kept[k] for k in dup]
    order = rng.permutation(len(kept))
    return [kept[k] for k in order], truth, info
