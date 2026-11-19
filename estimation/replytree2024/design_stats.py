"""Collection-design statistics from the trees built by the intake step.

These are descriptive tables for planning a collection: how reply volume is
spread over conversation sizes, whether large conversations have a busy root,
and how fast conversations grow and finish. Nothing here fits or scores a
model. Output is aggregate only: no post, conversation or author identifier.

Definitions (all times are seconds after the root post, on the intake clock):

  presence time   a reply exists at time c if it and every post on its path to
                  the root are dated at or before c. Its presence time is the
                  largest of those dates (never below 0). This is the rule the
                  intake step uses when it cuts a tree at a horizon, so sizes
                  here agree with an intake run at the same horizon.
  size S          1 + replies with presence time <= size_horizon_seconds.
  conversation    a root with S >= 2. A root with S == 1 has no reply by the
                  size horizon, whatever happens later.
  root degree K   direct replies to the root with presence time <= size horizon.
  single chain    a conversation in which every post has at most one reply.
  roots used      roots posted in `window`. The whole window must have
                  follow_up_seconds of follow-up before the observation end (and
                  the intake horizon, if the trees were cut at one), so that no
                  root of the window is left out and monthly scaling is exact.
  timing          for conversations of S >= tier: replies with presence time
                  <= c, as a share of replies within follow_up_seconds; and the
                  share of those conversations with no reply in (c, follow-up].
                  Both are bounded by the follow-up: a reply after it is unseen,
                  so both shares reach 100% at the follow-up by construction.
  root screen     the time at which a root receives its T-th direct reply, if it
                  does so by the size horizon (later arrivals count as not reached).
  V(s)            total posts (roots included) in conversations with S >= s: the
                  cost of retrieving each of them once, as it stands at the size
                  horizon.

Tiers, root degree and chains are defined on the tree at the size horizon, not
on the whole observed tree. Every kept conversation is included, single-author
ones too. Both differ from the September 2026 tables on the 2018-19 archives.

Settings without a default: window, size_horizon_seconds, follow_up_seconds.
Reporting grids have defaults, which are written into the output.
"""

import math
from collections import Counter
from dataclasses import asdict, dataclass

import numpy as np

from .trees import depths

DAY = 86400.0
DEFAULTS = dict(
    size_grid=(2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000),
    timing_tiers=(10, 100, 1000),
    checkpoints_seconds=(3600.0, 6 * 3600.0, DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY),
    quiet_tiers=(50, 100),
    quiet_root_max=2,
    root_thresholds=(10, 25, 50),
    caps_posts_per_30_days=(),
    overhead_fraction=None,
)
REQUIRED = ("window", "size_horizon_seconds", "follow_up_seconds")
NOTES = (
    "Sizes, tiers, root degree and single chains are measured on the tree at size_horizon_seconds, "
    "not on the whole observed tree.",
    "Timing shares are relative to the replies seen within follow_up_seconds, so they reach 100% there by "
    "construction; this does not show that conversations have ended.",
    "Root-screen shares count a root as reaching T direct replies only if it does so by the size horizon.",
    "V(s) is the number of posts in conversations of at least s posts at the size horizon: a planning "
    "reference that assumes perfect discovery, not a tested collection policy.",
    "Every conversation kept by the intake step is included, single-author conversations too.",
    "Aggregate counts only. Exact sparse counts are not an anonymity guarantee.",
)


@dataclass(frozen=True)
class DesignConfig:
    window: tuple                 # roots with window[0] <= time < window[1]
    size_horizon_seconds: float
    follow_up_seconds: float
    size_grid: tuple
    timing_tiers: tuple
    checkpoints_seconds: tuple
    quiet_tiers: tuple
    quiet_root_max: int
    root_thresholds: tuple
    caps_posts_per_30_days: tuple
    overhead_fraction: object     # required when caps are given

    @classmethod
    def from_dict(cls, d, intake_cfg):
        missing = [k for k in REQUIRED if k not in d]
        if missing:
            raise ValueError("design_stats is missing required settings: " + ", ".join(missing)
                             + ". No default is assumed for any of them.")
        unknown = sorted(set(d) - set(REQUIRED) - set(DEFAULTS))
        if unknown:
            raise ValueError("design_stats has unknown settings: " + ", ".join(unknown))
        v = {**DEFAULTS, **d}
        for k in ("size_grid", "timing_tiers", "checkpoints_seconds", "quiet_tiers", "root_thresholds",
                  "caps_posts_per_30_days", "window"):
            v[k] = tuple(v[k])
        c = cls(**v)
        num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
        if len(c.window) != 2 or not all(num(x) for x in c.window) or not c.window[0] < c.window[1]:
            raise ValueError("window must be [start, end] with start < end")
        if not (intake_cfg.cohort_start <= c.window[0] and c.window[1] <= intake_cfg.cohort_end):
            raise ValueError("window must lie inside the intake cohort window: roots outside it were not kept")
        if not (num(c.size_horizon_seconds) and num(c.follow_up_seconds)) \
                or not 0 < c.size_horizon_seconds <= c.follow_up_seconds:
            raise ValueError("require 0 < size_horizon_seconds <= follow_up_seconds")
        H = intake_cfg.horizon_seconds
        if H is not None and c.follow_up_seconds > H:
            raise ValueError(f"the trees were cut at horizon_seconds = {H} by the intake step; "
                             "follow_up_seconds cannot exceed it. Use an intake run with a longer horizon.")
        need = c.follow_up_seconds if H is None else H     # the intake step drops roots without H of follow-up
        if c.window[1] + need > intake_cfg.observation_end:
            raise ValueError(f"every root of the window needs {need} seconds of follow-up before observation_end "
                             f"= {intake_cfg.observation_end}; the window may end at "
                             f"{intake_cfg.observation_end - need} at the latest. Partial windows are refused "
                             "because they would understate monthly volume.")
        ints = lambda xs, lo: all(isinstance(x, int) and not isinstance(x, bool) and x >= lo for x in xs)
        if not (ints(c.size_grid, 2) and ints(c.timing_tiers, 2) and ints(c.quiet_tiers, 2)
                and ints(c.root_thresholds, 1) and ints((c.quiet_root_max,), 0)):
            raise ValueError("size_grid, timing_tiers and quiet_tiers need integers >= 2; "
                             "root_thresholds integers >= 1; quiet_root_max an integer >= 0")
        if not all(num(x) and x > 0 for x in c.checkpoints_seconds):
            raise ValueError("checkpoints_seconds must be positive numbers")
        if c.caps_posts_per_30_days:
            if not all(num(x) and x > 0 for x in c.caps_posts_per_30_days):
                raise ValueError("caps_posts_per_30_days must be positive numbers")
            if not (num(c.overhead_fraction) and c.overhead_fraction >= 0):
                raise ValueError("overhead_fraction is required with caps_posts_per_30_days; no default is assumed")
        return c


def presence_times(offsets, parents, rel_time):
    """(tree index, is_root, depth, presence time) for every post of a flattened batch of trees."""
    offsets = np.asarray(offsets, dtype=np.int64)
    parents = np.asarray(parents, dtype=np.int64)
    n = len(parents)
    tree_of = np.repeat(np.arange(len(offsets) - 1), np.diff(offsets))
    is_root = parents < 0
    gp = np.where(is_root, np.arange(n), parents + offsets[tree_of])
    d = depths(gp, is_root)
    e = np.where(is_root, 0.0, np.maximum(np.asarray(rel_time, dtype=np.float64), 0.0))
    if n and d.max() >= 1:
        order = np.argsort(d, kind="stable")
        bounds = np.searchsorted(d[order], np.arange(0, d.max() + 2))
        for lvl in range(1, int(d.max()) + 1):       # parents before children: one pass per level
            idx = order[bounds[lvl]:bounds[lvl + 1]]
            e[idx] = np.maximum(e[idx], e[gp[idx]])
    return tree_of, is_root, d, e


def _per_tree_sum(mask, offsets):
    return np.add.reduceat(mask.astype(np.int64), offsets[:-1])


class Accumulator:
    """Add intake buckets one at a time.

    Memory: the size histogram, one histogram of root degrees per quiet tier, a few sums per timing
    tier, and 16 bytes for every (conversation, threshold) pair in which the root reaches the
    threshold by the size horizon (needed for exact quantiles of the root-screen times). That part
    grows with the data: ten million such roots at three thresholds need about 0.5 GB, and up to
    about 1 GB while result() joins and sorts them. Pass fewer thresholds, or none, to avoid it.
    """

    def __init__(self, cfg):
        self.cfg = cfg
        self.checkpoints = tuple(c for c in cfg.checkpoints_seconds if c <= cfg.follow_up_seconds)
        self.screen_tiers = tuple(sorted(set(cfg.timing_tiers + cfg.quiet_tiers)))
        self.roots_in_window = 0
        self.sizes = Counter()                       # S -> conversations, S >= 2
        self.quiet = {t: dict(n=0, chains=0, degree=Counter()) for t in cfg.quiet_tiers}
        nc = len(self.checkpoints)
        self.timing = {t: dict(n=0, replies=0, posted=np.zeros(nc, dtype=np.int64), ended=np.zeros(nc, dtype=np.int64))
                       for t in cfg.timing_tiers}
        self.hits = [dict(S=[], t=[]) for _ in cfg.root_thresholds]

    def add_bucket(self, z):
        cfg = self.cfg
        a, b = cfg.window
        in_window = lambda t: (t >= a) & (t < b)
        self.roots_in_window += int(in_window(np.asarray(z["all_root_time"], dtype=np.float64)).sum())
        offsets = np.asarray(z["offsets"], dtype=np.int64)
        if len(offsets) <= 1:
            return
        used = in_window(np.asarray(z["root_time"], dtype=np.float64))
        if not used.any():
            return
        parents = np.asarray(z["parents"], dtype=np.int64)
        tree_of, is_root, d, e = presence_times(offsets, parents, z["rel_time"])
        reply = ~is_root
        in_size = reply & (e <= cfg.size_horizon_seconds)
        S = 1 + _per_tree_sum(in_size, offsets)
        conv = used & (S >= 2)
        u, n = np.unique(S[conv], return_counts=True)
        self.sizes.update(dict(zip(u.tolist(), n.tolist())))
        tiers = cfg.quiet_tiers + cfg.timing_tiers
        if not tiers or not (used & (S >= max(2, min(tiers)))).any():
            return
        direct = in_size & (parents == 0)
        if cfg.quiet_tiers:
            K = _per_tree_sum(direct, offsets)
            chain = np.maximum.reduceat(np.where(in_size, d, 0), offsets[:-1]) == S - 1
            for t, q in self.quiet.items():
                m = used & (S >= t)
                q["n"] += int(m.sum())
                q["chains"] += int(chain[m].sum())
                ku, kn = np.unique(K[m], return_counts=True)
                q["degree"].update(dict(zip(ku.tolist(), kn.tolist())))
        if cfg.timing_tiers:
            in_follow = reply & (e <= cfg.follow_up_seconds)
            n_follow = _per_tree_sum(in_follow, offsets)
            last = np.maximum.reduceat(np.where(in_follow, e, -np.inf), offsets[:-1])
            n_at = [_per_tree_sum(reply & (e <= c), offsets) for c in self.checkpoints]
            for t, g in self.timing.items():
                m = used & (S >= t)
                g["n"] += int(m.sum())
                g["replies"] += int(n_follow[m].sum())
                for j, c in enumerate(self.checkpoints):
                    g["posted"][j] += int(n_at[j][m].sum())
                    g["ended"][j] += int((last[m] <= c).sum())
        # time at which the root receives its T-th direct reply, for roots that do so by the size horizon
        idx = np.flatnonzero(direct & used[tree_of] & (S >= self.screen_tiers[0])[tree_of])
        if len(idx):
            idx = idx[np.lexsort((e[idx], tree_of[idx]))]
            t = tree_of[idx]
            first = np.r_[0, np.flatnonzero(np.diff(t)) + 1]
            rank = np.arange(len(idx)) - np.repeat(first, np.diff(np.r_[first, len(idx)]))
            for j, T in enumerate(cfg.root_thresholds):
                m = rank == T - 1
                self.hits[j]["S"].append(S[t[m]])
                self.hits[j]["t"].append(e[idx[m]])

    def result(self):
        cfg = self.cfg
        sizes = np.array(sorted(self.sizes), dtype=np.int64)
        counts = np.array([self.sizes[s] for s in sizes.tolist()], dtype=np.int64)
        conversations, posts = int(counts.sum()), int((sizes * counts).sum())
        replies = posts - conversations
        per30 = 30 * DAY / (cfg.window[1] - cfg.window[0])
        ratio = lambda x, y: (float(x) / float(y)) if y else None

        def tail(s):
            m = sizes >= s
            return int(counts[m].sum()), int((sizes[m] * counts[m]).sum())

        volume = []
        for s in cfg.size_grid:
            c, p = tail(s)
            volume.append(dict(s=s, conversations=c, posts=p, replies=p - c, share_of_replies=ratio(p - c, replies),
                               share_of_conversations=ratio(c, conversations), posts_per_30_days=p * per30))
        quiet = []
        for t in cfg.quiet_tiers:
            q = self.quiet[t]
            ks = np.array(sorted(q["degree"]), dtype=np.int64)
            kn = np.array([q["degree"][k] for k in ks.tolist()], dtype=np.int64)
            median = None
            if q["n"]:                               # median of the root degrees, from their histogram
                cum = np.cumsum(kn)
                lo, hi = ks[np.searchsorted(cum, (q["n"] + 1) // 2)], ks[np.searchsorted(cum, q["n"] // 2 + 1)]
                median = float(lo + hi) / 2
            quiet.append(dict(
                tier=t, conversations=q["n"],
                share_root_degree_at_most=dict(max=cfg.quiet_root_max,
                                               share=ratio(kn[ks <= cfg.quiet_root_max].sum(), q["n"])),
                median_root_degree=median, share_single_chains=ratio(q["chains"], q["n"])))
        timing = []
        for t in cfg.timing_tiers:
            g = self.timing[t]
            timing.append(dict(tier=t, conversations=g["n"], replies_within_follow_up=g["replies"], checkpoints=[
                dict(seconds=c, share_of_replies_posted=ratio(g["posted"][j], g["replies"]),
                     share_of_conversations_with_no_later_reply=ratio(g["ended"][j], g["n"]))
                for j, c in enumerate(self.checkpoints)]))
        rows = {}
        for j, T in enumerate(cfg.root_thresholds):
            h = self.hits[j]                          # joined one threshold at a time, and kept joined
            for k, dtype in (("S", np.int64), ("t", np.float64)):
                h[k] = [np.concatenate(h[k]) if h[k] else np.zeros(0, dtype=dtype)]
            hs, ht = h["S"][0], h["t"][0]
            for t in self.screen_tiers:
                got = ht[hs >= t]
                rows[(t, j)] = dict(tier=t, direct_replies=T, share_reaching_by_size_horizon=ratio(len(got), tail(t)[0]),
                                    median_hours=(float(np.median(got)) / 3600 if len(got) else None),
                                    p90_hours=(float(np.quantile(got, 0.9)) / 3600 if len(got) else None))
        screen = [rows[(t, j)] for t in self.screen_tiers for j in range(len(cfg.root_thresholds))]
        caps = []
        for cap in cfg.caps_posts_per_30_days:
            # V(s) only changes at observed sizes: the smallest s that fits is one above the largest
            # observed size whose tail does not fit
            v_tail = np.cumsum((sizes * counts)[::-1])[::-1] * per30 * (1 + cfg.overhead_fraction)
            over = np.flatnonzero(v_tail > cap)
            s = 2 if not len(over) else int(sizes[over[-1]]) + 1
            c, p = tail(s)
            caps.append(dict(cap_posts_per_30_days=cap, smallest_cutoff=(s if conversations else None),
                             no_conversation_fits=bool(conversations and not c), conversations=c, posts=p,
                             posts_per_30_days=p * per30, share_of_replies=ratio(p - c, replies)))
        return dict(
            settings={k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(cfg).items()},
            checkpoints_used_seconds=list(self.checkpoints),
            notes=list(NOTES),
            population=dict(
                roots_in_window=self.roots_in_window, conversations=conversations,
                roots_with_no_reply_by_size_horizon=self.roots_in_window - conversations,
                share_of_roots_with_a_reply=ratio(conversations, self.roots_in_window),
                replies=replies, posts_in_conversations=posts,
                largest_conversation=(int(sizes[-1]) if len(sizes) else None),
                window_days=(cfg.window[1] - cfg.window[0]) / DAY),
            volume_by_size=volume, quiet_roots=quiet, timing=timing, root_screen=screen, cutoff_for_cap=caps,
            size_histogram=dict(size=sizes.tolist(), conversations=counts.tolist()))
