"""G18 generator: simulate whole conversations (vendored from gm_model.py).

The code below the helper is copied unchanged from
claude/general_model/code/gm_model.py, whose output is tested there against
explicit parent lists and exact sampling laws, and is tested here against the
likelihood (tests/test_g18.py). Nothing is clipped: a tree above the post
limit is stopped and counted as an excess tree, and a chunk above its limit is
aborted and counted.
"""

from types import SimpleNamespace

import numpy as np
from scipy.special import expit, log_ndtr, ndtri_exp, zeta


def _coerce(P):
    """Accept G18Parameters (no screened-variant fields) or the original Params."""
    if hasattr(P, "sk") and hasattr(P, "delta"):
        return P
    d = {k: getattr(P, k) for k in P.__dataclass_fields__}
    return SimpleNamespace(sk=0.0, delta=0.0, **d)


def sample_root(P, n, rng):
    """Inverse-transform sampling within a component; returns ln K (float)."""
    comp1 = rng.random(n) < P.w
    u = rng.random(n)
    a = np.where(comp1, P.a1, P.a2)
    t = np.where(comp1, P.t1, P.t2)
    y0 = a / t
    y1 = -ndtri_exp(np.log(u) + log_ndtr(-y0))
    x = (y1 - y0) / t
    return np.maximum(x, 0.0), comp1


# ---------------------------------------------------------------- branch law
def branch_alpha(P, K, level1):
    b = np.where(level1, P.b1, P.b2)
    return 1 + (P.alpha0 - 1) * np.exp(-b * np.log(K))


def branch_mean(alpha):
    return 1 + zeta(alpha, 1)


def branch_logsf(d, alpha):
    """log P(D >= d | branch) = -alpha * ln(d-1), d >= 2."""
    return -alpha * np.log(np.asarray(d, float) - 1)


# ---------------------------------------------------------------- generator
SLICE = 250_000   # segments per arithmetic slice within a generation (memory bound only)


class ChunkAbort(RuntimeError):
    """A whole chunk exceeded its post budget; it is counted, never redrawn."""


def simulate_chunk(P, n, rng, max_tree_posts=5_000_000, max_chunk_posts=6_000_000,
                   explicit=False):
    """Simulate n conversations.

    Returns a dict with per-tree arrays (size, depth, root_degree, excess),
    a segment table (tree, length, root, ks, end_degree, group, start_depth,
    end_node) and, if explicit=True, flattened explicit parent arrays
    (offsets, parents) for the completed (non-excess) trees.
    Excess trees (> max_tree_posts) are stopped, flagged and excluded from
    all returned structure; their count is reported. Nothing is clipped.
    """
    P = _coerce(P)
    lnK, comp1 = sample_root(P, n, rng)
    excess = lnK >= np.log(max_tree_posts)
    # Known lower bound on the size of each excess tree (reporting only).
    lower = np.where(excess, np.floor(np.exp(np.minimum(lnK, 700.0))) + 1, 0.0)
    K = np.where(excess, 0, np.floor(np.exp(np.minimum(lnK, 40)))).astype(np.int64)
    theta = rng.standard_normal(n) + P.delta * (~comp1)
    x = np.log(np.maximum(K, 1))
    u1 = expit(P.c0 - P.c1 * x + P.s1 * theta)
    base = P.mu - P.gam * x + P.sig * theta
    alpha1 = branch_alpha(P, np.maximum(K, 1), True)
    alpha2 = branch_alpha(P, np.maximum(K, 1), False)
    phi1 = expit(P.g0 + P.f1 * x + P.sk * theta) / branch_mean(alpha1)
    phi2 = expit(P.f0 + P.f1 * x + P.sk * theta) / branch_mean(alpha2)
    size = np.ones(n, dtype=np.int64)   # roots; every reply is counted in a segment
    depth = np.zeros(n, dtype=np.int64)
    # Node ids: roots are 0..n-1; new posts are numbered in creation order.
    next_id = n
    alive = ~excess
    tid = np.repeat(np.arange(n), np.where(alive, K, 0))
    par = tid.copy()               # root segments hang from the root node
    root = np.ones(len(tid), bool)
    ks = K[tid]
    sdepth = np.ones(len(tid), dtype=np.int64)
    segs = []
    node_tree, node_parent = [], []
    total = n
    if n + int(K[alive].sum()) > max_chunk_posts:
        raise ChunkAbort(f"root replies alone exceed {max_chunk_posts} posts")
    while len(tid):
        m = len(tid)
        # All random numbers of a generation are drawn at once, in a fixed
        # order; the per-segment arithmetic is then done in bounded slices so
        # a generation with millions of segments (a giant root or branch)
        # does not multiply memory. Results are bit-identical to the unsliced
        # version (tests/reference_generator.py).
        U = rng.random((3, m))
        E = P.tau * rng.standard_normal(m) if P.tau > 0 else None
        cont = np.empty(m, dtype=bool)
        seg_len_f = np.empty(m)
        for a in range(0, m, SLICE):
            b = min(m, a + SLICE)
            t = tid[a:b]
            z = base[t] + (E[a:b] if E is not None else 0.0)
            log_u = -np.logaddexp(0, -z)             # log u, stable near u=1
            c = U[0, a:b] < np.where(root[a:b], u1[t], np.exp(log_u))
            with np.errstate(divide="ignore", over="ignore"):
                extra = np.floor(np.log(U[1, a:b]) / log_u)   # geometric: P(G>=g)=u^(g-1)
            # Per-tree guard below acts before any integer conversion (a
            # near-1 u can imply an astronomically long segment).
            seg_len_f[a:b] = 1 + np.where(c, 1 + extra, 0)
            cont[a:b] = c
        u2 = U[2].copy()
        del U, E
        grow = np.bincount(tid, weights=seg_len_f, minlength=n)
        over = (size + grow) > max_tree_posts
        if over.any():
            lower = np.where(over, np.maximum(lower, size + grow), lower)
            excess |= over
            keep = ~over[tid]
            tid, par, root, ks, sdepth = tid[keep], par[keep], root[keep], ks[keep], sdepth[keep]
            cont, seg_len_f, u2 = cont[keep], seg_len_f[keep], u2[keep]
            m = len(tid)
            if m == 0:
                break
        L = seg_len_f.astype(np.int64)
        del seg_len_f
        lvl1_end = root & ~cont
        br = np.empty(m, dtype=bool)
        for a in range(0, m, SLICE):
            b = min(m, a + SLICE)
            t = tid[a:b]
            br[a:b] = u2[a:b] < np.where(lvl1_end[a:b], phi1[t], phi2[t])
        del u2
        D = np.zeros(m, dtype=np.int64)
        if br.any():
            a = np.where(lvl1_end[br], alpha1[tid[br]], alpha2[tid[br]])
            with np.errstate(over="ignore"):
                logy = -np.log(rng.random(int(br.sum()))) / a     # Pareto
            big = logy >= np.log(max_tree_posts)
            if big.any():
                t_big = tid[br][big]
                np.maximum.at(lower, t_big, size[t_big] + np.exp(np.minimum(logy[big], 700.0)))
                excess[t_big] = True
                logy = np.where(big, 0.0, logy)
            D[br] = 1 + np.floor(np.exp(logy)).astype(np.int64)
        np.add.at(size, tid, L)
        end_depth = sdepth + L - 1
        np.maximum.at(depth, tid, end_depth)
        start_node = next_id + np.cumsum(L) - L
        end_node = start_node + L - 1
        next_id += int(L.sum())
        i32 = lambda a: a.astype(np.int32)       # bounded by the chunk cap; halves memory
        segs.append((i32(tid), i32(L), root, i32(ks), i32(D), i32(par), i32(sdepth), i32(end_node)))
        if explicit:
            node_tree.append(np.repeat(tid, L))
            # First post's parent is par; later posts' parents are the previous post.
            p = np.arange(start_node[0] if m else 0, next_id, dtype=np.int64) - 1
            first_pos = start_node - (start_node[0] if m else 0)
            p[first_pos] = par
            node_parent.append(p)
        # Guard on offspring before creating them.
        growth = np.bincount(tid, weights=D, minlength=n)
        over = (size + growth) > max_tree_posts
        lower = np.where(over, np.maximum(lower, size + growth), lower)
        excess |= over
        sel = br & ~excess[tid]
        total += int(L.sum())
        if total + int(D[sel].sum()) > max_chunk_posts:
            raise ChunkAbort(f"chunk exceeded {max_chunk_posts} posts")
        cnt = D[sel]
        tid = np.repeat(tid[sel], cnt)
        par = np.repeat(end_node[sel], cnt)
        sdepth = np.repeat(end_depth[sel] + 1, cnt)
        ks = np.repeat(D[sel], cnt)
        root = np.zeros(len(tid), bool)
    if segs:
        seg = {k: np.concatenate(v) for k, v in zip(
            ("tree", "length", "root", "ks", "end_degree", "group", "start_depth", "end_node"), zip(*segs))}
    else:
        seg = {k: np.zeros(0, dtype=np.int64) for k in
               ("tree", "length", "root", "ks", "end_degree", "group", "start_depth", "end_node")}
        seg["root"] = seg["root"].astype(bool)
    keep = ~excess[seg["tree"]]
    seg = {k: v[keep] for k, v in seg.items()}
    # A branch whose children were never generated because the tree hit the
    # guard belongs to an excess tree, so it was removed above.
    out = dict(size=size, depth=depth, root_degree=K, excess=excess, theta=theta,
               component1=comp1, seg=seg, n_excess=int(excess.sum()),
               excess_lower_bounds=np.maximum(size, lower)[excess])
    if explicit:
        out.update(_explicit(n, excess, node_tree, node_parent))
    return out


def _explicit(n, excess, node_tree, node_parent):
    """Assemble per-tree parent arrays with local indices (roots first)."""
    if node_tree:
        t = np.concatenate([np.arange(n)] + node_tree)
        gp = np.concatenate([np.full(n, -1, dtype=np.int64)] + node_parent)
    else:
        t = np.arange(n)
        gp = np.full(n, -1, dtype=np.int64)
    keep = ~excess[t]
    ids = np.flatnonzero(keep)
    t, gp = t[keep], gp[keep]
    order = np.argsort(t, kind="stable")      # creation order within tree
    t, gp, ids = t[order], gp[order], ids[order]
    sizes = np.bincount(t, minlength=n)[~excess]
    offsets = np.r_[0, np.cumsum(sizes)]
    # Map global creation ids to positions in the new order.
    pos = np.full(len(keep), -1, dtype=np.int64)
    pos[ids] = np.arange(len(ids))
    tree_rank = np.cumsum(~excess) - 1
    start = offsets[tree_rank[t]]
    parents = np.where(gp < 0, -1, pos[np.maximum(gp, 0)] - start)
    return dict(offsets=offsets, parents=parents.astype(np.int32))


def trees_view(out):
    """Per-tree arrays and segment table restricted to completed trees."""
    ok = ~out["excess"]
    idx = np.cumsum(ok) - 1
    trees = {k: out[k][ok] for k in ("size", "depth", "root_degree")}
    seg = dict(out["seg"])
    seg["tree"] = idx[seg["tree"]]
    return trees, seg


def simulate(P, n, seed, chunk=10_000, max_tree_posts=5_000_000, max_chunk_posts=6_000_000,
             consumer=None, explicit=False):
    """Simulate n trees in chunks with independent SeedSequence streams.

    consumer(out) is called for every completed chunk (e.g. to accumulate
    summaries or tree metrics) so memory stays bounded. Returns counts of
    trees, excess trees and aborted chunks; nothing is silently redrawn.
    """
    streams = np.random.SeedSequence(seed).spawn((n + chunk - 1) // chunk)
    report = dict(trees_requested=n, trees_completed=0, excess_trees=0, aborted_chunks=0,
                  aborted_trees=0, abort_messages=[], excess_lower_bounds=[])
    for j, ss in enumerate(streams):
        m = min(chunk, n - j * chunk)
        try:
            out = simulate_chunk(P, m, np.random.default_rng(ss), max_tree_posts, max_chunk_posts, explicit)
        except ChunkAbort as exc:
            report["aborted_chunks"] += 1
            report["aborted_trees"] += m
            report["abort_messages"].append(str(exc))
            continue
        report["trees_completed"] += m - out["n_excess"]
        report["excess_trees"] += out["n_excess"]
        report["excess_lower_bounds"] += out["excess_lower_bounds"].tolist()
        if consumer is not None:
            consumer(out)
    return report
