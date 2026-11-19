"""Tree validation and the per-tree statistics that the G18 likelihood needs.

Trees are flattened as in trees.py: tree t is parents[offsets[t]:offsets[t+1]],
local parent indices, -1 for the root at the first position, parents before
children. Roles: a *direct reply* has the root as parent; every other
non-root post is a *later post*.

G18 sufficient statistics (see plan/LIKELIHOOD_NOTE.md):
  per tree     K (direct replies), C (direct replies with exactly one child),
               and for every chain segment that contains later posts the
               number a of later posts in it that continued (exactly one
               child). A segment made of a single direct reply contributes
               nothing here.
  per ending   (tree, role of the ending post, its number of children D);
               D == 0 is a leaf, D >= 2 a branch.
"""

from dataclasses import dataclass

import numpy as np

from .trees import tree_metrics


def validate_parents(parents):
    """Check one tree given as a parent list; return it as an int64 array."""
    raw = np.asarray(parents)
    if raw.dtype.kind not in "iu":
        raise ValueError("parents must be integers; refusing to cast a non-integer array")
    p = raw.astype(np.int64)
    if p.ndim != 1 or len(p) < 1 or p[0] != -1:
        raise ValueError("parents must be 1-D with the root (-1) first")
    idx = np.arange(len(p))
    if np.any(p[1:] < 0) or np.any(p[1:] >= idx[1:]):
        raise ValueError("every non-root parent must be an earlier position")
    return p


def flatten(trees):
    """List of parent lists -> (offsets, parents) flattened arrays."""
    arrs = [validate_parents(t) for t in trees]
    offsets = np.r_[0, np.cumsum([len(a) for a in arrs])].astype(np.int64)
    parents = np.concatenate(arrs) if arrs else np.zeros(0, dtype=np.int64)
    return offsets, parents


@dataclass
class G18Stats:
    """Sufficient statistics of a set of trees for the G18 likelihood.

    Segment and ending tables are stored as unique rows with counts, so their
    size grows with the number of distinct (tree, value) pairs, not with the
    number of posts.
    """
    n_trees: int
    K: np.ndarray            # (n_trees,) direct replies
    C: np.ndarray            # (n_trees,) direct replies with exactly one child
    seg_tree: np.ndarray     # later-post segments: tree index
    seg_a: np.ndarray        #   later posts in the segment that continued
    seg_cnt: np.ndarray      #   number of such segments in the tree
    end_tree: np.ndarray     # ending posts: tree index
    end_role: np.ndarray     #   1 = direct reply, 2 = later post
    end_degree: np.ndarray   #   children of the ending post (0 or >= 2)
    end_cnt: np.ndarray      #   number of such endings in the tree
    outcomes: dict           # per-tree size, depth, width, root_degree


def _tree_chunks(offsets, chunk_posts):
    """Yield (lo, hi) tree ranges holding at most chunk_posts posts (one tree may exceed it)."""
    n = len(offsets) - 1
    lo = 0
    while lo < n:
        hi = int(np.searchsorted(offsets, offsets[lo] + chunk_posts, side="right")) - 1
        hi = min(max(hi, lo + 1), n)
        yield lo, hi
        lo = hi


def _unique_rows(*cols):
    """Unique rows of nonnegative integer columns, with counts (1-D key, no row sort)."""
    cols = [np.asarray(c, np.int64) for c in cols]
    if len(cols[0]) == 0:
        return [c[:0] for c in cols], np.zeros(0, np.int64)
    bases = [int(c.max()) + 1 for c in cols]
    key = np.zeros(len(cols[0]), np.int64)
    for c, b in zip(cols, bases):
        key = key * b + c
    ukey, cnt = np.unique(key, return_counts=True)
    out = []
    for b in reversed(bases):
        out.append(ukey % b)
        ukey = ukey // b
    return out[::-1], cnt


def g18_stats(offsets, parents, chunk_posts=1_500_000, with_wiener=False):
    """Compute G18Stats (and per-tree outcomes) for flattened trees, in bounded memory."""
    offsets = np.asarray(offsets, np.int64)
    n = len(offsets) - 1
    keys = ("size", "depth", "width", "root_degree") + (("wiener",) if with_wiener else ())
    outcomes = {k: [] for k in keys}
    K, C, segs, ends = [], [], [], []
    for lo, hi in _tree_chunks(offsets, chunk_posts):
        per, seg = tree_metrics(offsets[lo:hi + 1], parents[offsets[lo]:offsets[hi]], segments=True)
        for k in keys:
            outcomes[k].append(per[k])
        K.append(per["root_degree"].astype(np.int64))
        C.append(per["root_continuations"].astype(np.int64))
        single = seg["root"] & (seg["length"] == 1)
        later = ~single
        a = np.where(seg["root"], seg["length"] - 2, seg["length"] - 1)[later]
        (t, a), cnt = _unique_rows(seg["tree"][later], a)
        segs.append((t + lo, a, cnt))
        (t, r, d), cnt = _unique_rows(seg["tree"], np.where(single, 0, 1), seg["end_degree"])
        ends.append((t + lo, r + 1, d, cnt))
    cat = lambda parts, i: np.concatenate([q[i] for q in parts]) if parts else np.zeros(0, np.int64)
    return G18Stats(
        n_trees=n, K=np.concatenate(K), C=np.concatenate(C),
        seg_tree=cat(segs, 0), seg_a=cat(segs, 1), seg_cnt=cat(segs, 2),
        end_tree=cat(ends, 0), end_role=cat(ends, 1).astype(np.int8), end_degree=cat(ends, 2),
        end_cnt=cat(ends, 3), outcomes={k: np.concatenate(v) for k, v in outcomes.items()})


def subset_stats(st, mask):
    """G18Stats restricted to the trees where mask is True (tree indices renumbered)."""
    mask = np.asarray(mask, bool)
    new = np.cumsum(mask) - 1
    ks, ke = mask[st.seg_tree], mask[st.end_tree]
    return G18Stats(
        n_trees=int(mask.sum()), K=st.K[mask], C=st.C[mask],
        seg_tree=new[st.seg_tree[ks]], seg_a=st.seg_a[ks], seg_cnt=st.seg_cnt[ks],
        end_tree=new[st.end_tree[ke]], end_role=st.end_role[ke], end_degree=st.end_degree[ke],
        end_cnt=st.end_cnt[ke], outcomes={k: v[mask] for k, v in st.outcomes.items()})


def save_stats(path, st):
    np.savez_compressed(path, n_trees=st.n_trees, K=st.K, C=st.C, seg_tree=st.seg_tree, seg_a=st.seg_a,
                        seg_cnt=st.seg_cnt, end_tree=st.end_tree, end_role=st.end_role,
                        end_degree=st.end_degree, end_cnt=st.end_cnt,
                        **{"out_" + k: v for k, v in st.outcomes.items()})


def load_stats(path):
    z = np.load(path)
    return G18Stats(n_trees=int(z["n_trees"]), K=z["K"], C=z["C"], seg_tree=z["seg_tree"], seg_a=z["seg_a"],
                    seg_cnt=z["seg_cnt"], end_tree=z["end_tree"], end_role=z["end_role"],
                    end_degree=z["end_degree"], end_cnt=z["end_cnt"],
                    outcomes={k[4:]: z[k] for k in z.files if k.startswith("out_")})


def naive_stats(parents):
    """Slow, obviously-correct statistics for one tree (used only in tests)."""
    p = validate_parents(parents)
    n = len(p)
    deg = np.zeros(n, dtype=int)
    for j in range(1, n):
        deg[p[j]] += 1
    K = int(deg[0])
    C = sum(1 for j in range(1, n) if p[j] == 0 and deg[j] == 1)
    seg_a, ends = [], []
    for j in range(1, n):
        if deg[j] == 1:
            continue                       # not an ending post
        # walk up to the start of the segment that ends at j
        chain = [j]
        while p[chain[-1]] != 0 and deg[p[chain[-1]]] == 1:
            chain.append(p[chain[-1]])
        start = chain[-1]
        L = len(chain)
        start_direct = p[start] == 0
        if start_direct and L == 1:
            ends.append((1, int(deg[j])))
        else:
            seg_a.append(L - 2 if start_direct else L - 1)
            ends.append((2, int(deg[j])))
    return dict(K=K, C=C, seg_a=sorted(seg_a), ends=sorted(ends))
