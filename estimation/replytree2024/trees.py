"""Exact per-tree metrics and chain segments from explicit parent arrays.

Trees are stored flattened: tree t occupies parents[offsets[t]:offsets[t+1]],
with local parent indices, parents[offsets[t]] == -1 for the root, and every
parent preceding its children. The same code is applied to the Saveski
archives and to simulated trees, so every reported diagnostic uses one
definition.

Definitions (Saveski et al. 2021 / Nishi et al. 2016 conventions):
  size        posts including the root
  depth       maximum distance from the root, in edges
  width       maximum number of posts at one depth (the root level counts)
  wiener      mean pairwise distance, 2*sum_edges s(N-s) / (N(N-1))
  root_degree direct replies to the root (K)
  segment     a maximal reply chain: it starts at a child of the root or of a
              post with >=2 children, continues through posts with exactly
              one child, and ends at the first post with 0 or >=2 children.
              Its length is its number of posts (>=1). ks is the degree of
              the post it hangs from (K for root segments).
"""

import numpy as np


def depths(gp, is_root):
    """Distance to the root by pointer jumping (list ranking), O(N log depth)."""
    n = len(gp)
    jump = np.where(is_root, np.arange(n), gp)
    dist = (~is_root).astype(np.int64)
    while True:
        nxt = jump[jump]
        if np.array_equal(nxt, jump):
            return dist
        dist = dist + dist[jump]
        jump = nxt


def tree_metrics(offsets, parents, segments=True):
    """Return (per_tree dict, segment dict or None) for a batch of trees."""
    offsets = np.asarray(offsets, dtype=np.int64)
    base = offsets[0]
    offsets = offsets - base
    parents = np.asarray(parents)
    n = len(offsets) - 1
    size = np.diff(offsets)
    if np.any(size < 1):
        raise ValueError("Every tree needs a root")
    N = int(offsets[-1])
    tree = np.repeat(np.arange(n), size)
    starts = offsets[:-1]
    is_root = parents == -1
    if not (np.array_equal(np.flatnonzero(is_root), starts)):
        raise ValueError("Each tree must have exactly one root, at its first position")
    local = np.arange(N) - starts[tree]
    if np.any((parents[~is_root] < 0) | (parents[~is_root] >= local[~is_root])):
        raise ValueError("Parents must precede their children within a tree")
    gp = np.where(is_root, -1, parents.astype(np.int64) + starts[tree])
    nonroot = ~is_root
    deg = np.bincount(gp[nonroot], minlength=N)
    depth = depths(gp, is_root)
    K = deg[starts]
    out = {"size": size, "root_degree": K}
    out["depth"] = np.maximum.reduceat(depth, starts)
    # Width: largest level population, including the root level.
    dmax = int(depth.max()) + 1
    key = tree * dmax + depth
    ukey, counts = np.unique(key, return_counts=True)
    width = np.zeros(n, dtype=np.int64)
    np.maximum.at(width, ukey // dmax, counts)
    out["width"] = width
    # Subtree sizes, deepest level first; then the Wiener edge-cut identity.
    sub = np.ones(N, dtype=np.int64)
    order = np.argsort(-depth, kind="stable")
    level = depth[order]
    cuts = np.flatnonzero(np.diff(level)) + 1
    for block in np.split(order, cuts):
        if depth[block[0]] == 0:
            break
        np.add.at(sub, gp[block], sub[block])
    s = sub[nonroot].astype(float)
    S = size[tree[nonroot]].astype(float)
    pair = np.bincount(tree[nonroot], weights=s * (S - s), minlength=n)
    with np.errstate(invalid="ignore", divide="ignore"):
        out["wiener"] = np.where(size > 1, 2 * pair / (size * (size - 1.0)), np.nan)
    # Reply-degree bookkeeping, split into direct (level-1) and later posts.
    level1 = nonroot & (depth == 1)
    later = nonroot & (depth >= 2)
    d = deg
    out["root_continuations"] = np.bincount(tree[level1 & (d == 1)], minlength=n)
    out["root_forks"] = np.bincount(tree[level1 & (d >= 2)], minlength=n)
    out["later_nodes"] = np.bincount(tree[later], minlength=n)
    out["later_continuations"] = np.bincount(tree[later & (d == 1)], minlength=n)
    out["forks"] = np.bincount(tree[nonroot & (d >= 2)], minlength=n)
    out["leaves"] = np.bincount(tree[nonroot & (d == 0)], minlength=n)
    out["nonbinary_nodes"] = np.bincount(tree[nonroot & (d >= 3)], minlength=n)
    maxdeg = np.zeros(n, dtype=np.int64)
    np.maximum.at(maxdeg, tree[nonroot], d[nonroot])
    out["max_reply_degree"] = maxdeg
    # Branch-degree events (nonroot posts with >=2 children), by level.
    br = nonroot & (d >= 2)
    out["_branch_events"] = dict(tree=tree[br], degree=d[br], level1=level1[br])
    # Parent-degree conditioned child degree (paper Fig. 7a), per node.
    pdeg = d[gp[nonroot]]
    out["_fig7a"] = dict(tree=tree[nonroot], parent_degree=pdeg, degree=d[nonroot])
    if not segments:
        return out, None
    parent_is_root = np.zeros(N, dtype=bool)
    parent_is_root[nonroot] = is_root[gp[nonroot]]
    seg_start = nonroot & (parent_is_root | (d[np.maximum(gp, 0)] != 1))
    seg_end = nonroot & (d != 1)
    up = np.where(seg_start | is_root, np.arange(N), gp)
    while True:
        nxt = up[up]
        if np.array_equal(nxt, up):
            break
        up = nxt
    ends = np.flatnonzero(seg_end)
    first = up[ends]
    if not np.all(seg_start[first]):
        raise AssertionError("Segment reconstruction failed")
    seg = dict(
        tree=tree[ends],
        length=depth[ends] - depth[first] + 1,
        root=parent_is_root[first],
        ks=d[gp[first]],
        end_degree=d[ends],
        group=gp[first] + base,  # global id of the post the segment hangs from
        start_depth=depth[first],
    )
    return out, seg


def iter_chunks(offsets, chunk_trees):
    """Yield (lo, hi) tree ranges of at most chunk_trees trees."""
    n = len(offsets) - 1
    for lo in range(0, n, chunk_trees):
        yield lo, min(n, lo + chunk_trees)
