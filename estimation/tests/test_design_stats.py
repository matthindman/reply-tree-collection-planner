"""Tests of the collection-design statistics.

The vectorized code is compared with a plain-Python reference written
separately below (loops over posts, no shared helpers), on hand-made trees
with answers worked out by hand, and on synthetic records passed through the
intake step.
"""
import json
import math
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from replytree2024 import design_stats, g18, intake, synthetic  # noqa: E402

P = g18.G18Parameters.from_dict(json.loads((HERE.parent / "fixtures" / "trees_v1.json").read_text())
                                ["g18_parameters"]["mc_check"])
DAY = 86400.0
INTAKE = dict(cohort_start=0.0, cohort_end=60 * DAY, observation_end=200 * DAY, horizon_seconds=None,
              missing_parent_rule="drop_subtree", reply_before_parent_rule="keep", cycle_rule="quarantine_tree",
              n_buckets=4, max_bucket_records=10_000_000, max_malformed_records=0)
DESIGN = dict(window=[0.0, 30 * DAY], size_horizon_seconds=30 * DAY, follow_up_seconds=90 * DAY,
              size_grid=[2, 3, 5, 10, 20, 50], timing_tiers=[2, 5, 20], quiet_tiers=[3, 10],
              root_thresholds=[1, 2, 5], checkpoints_seconds=[3600.0, DAY, 7 * DAY, 30 * DAY, 90 * DAY, 400 * DAY],
              caps_posts_per_30_days=[50.0, 2000.0, 1e9], overhead_fraction=0.1)


def bucket(trees, zero_reply_root_times=()):
    """An intake-style bucket from [(root_time, parents, rel_times)]."""
    sizes = [len(p) for _, p, _ in trees]
    return dict(offsets=np.r_[0, np.cumsum(sizes)].astype(np.int64),
                parents=np.array([x for _, p, _ in trees for x in p], dtype=np.int32),
                rel_time=np.array([x for _, _, t in trees for x in t], dtype=np.float64),
                root_time=np.array([r for r, _, _ in trees], dtype=np.float64),
                all_root_time=np.array([r for r, _, _ in trees] + list(zero_reply_root_times), dtype=np.float64))


def reference(buckets, cfg):
    """The same statistics by explicit loops. Returns a dict shaped like Accumulator.result()."""
    a, b = cfg.window
    Hs, F = cfg.size_horizon_seconds, cfg.follow_up_seconds
    cps = [c for c in cfg.checkpoints_seconds if c <= F]
    ok = lambda t: a <= t < b
    roots_in_window = 0
    convs = []
    for z in buckets:
        for t in z["all_root_time"]:
            roots_in_window += ok(t)
        for i in range(len(z["root_time"])):
            if not ok(z["root_time"][i]):
                continue
            par = z["parents"][z["offsets"][i]:z["offsets"][i + 1]].tolist()
            rel = z["rel_time"][z["offsets"][i]:z["offsets"][i + 1]].tolist()
            pres, depth = [0.0], [0]
            for j in range(1, len(par)):                      # parents precede children
                pres.append(max(rel[j], pres[par[j]], 0.0))
                depth.append(depth[par[j]] + 1)
            kept = [j for j in range(1, len(par)) if pres[j] <= Hs]
            S = 1 + len(kept)
            if S < 2:
                continue
            kids = Counter(par[j] for j in kept)
            direct = sorted(pres[j] for j in kept if par[j] == 0)
            follow = [pres[j] for j in range(1, len(par)) if pres[j] <= F]
            convs.append(dict(S=S, K=len(direct), chain=max(kids.values()) == 1, direct=direct, follow=follow))
    hist = Counter(c["S"] for c in convs)
    n_conv, posts = len(convs), sum(c["S"] for c in convs)
    replies = posts - n_conv
    per30 = 30 * DAY / (b - a)
    ratio = lambda x, y: (x / y) if y else None
    volume = []
    for s in cfg.size_grid:
        sub = [c for c in convs if c["S"] >= s]
        p = sum(c["S"] for c in sub)
        volume.append(dict(s=s, conversations=len(sub), posts=p, replies=p - len(sub),
                           share_of_replies=ratio(p - len(sub), replies), share_of_conversations=ratio(len(sub), n_conv),
                           posts_per_30_days=p * per30))
    quiet = []
    for t in cfg.quiet_tiers:
        sub = [c for c in convs if c["S"] >= t]
        ks = sorted(c["K"] for c in sub)
        med = None if not ks else (ks[len(ks) // 2] if len(ks) % 2 else (ks[len(ks) // 2 - 1] + ks[len(ks) // 2]) / 2)
        quiet.append(dict(tier=t, conversations=len(sub),
                          share_root_degree_at_most=dict(max=cfg.quiet_root_max,
                                                         share=ratio(sum(c["K"] <= cfg.quiet_root_max for c in sub), len(sub))),
                          median_root_degree=med, share_single_chains=ratio(sum(c["chain"] for c in sub), len(sub))))
    timing = []
    for t in cfg.timing_tiers:
        sub = [c for c in convs if c["S"] >= t]
        total = sum(len(c["follow"]) for c in sub)
        timing.append(dict(tier=t, conversations=len(sub), replies_within_follow_up=total, checkpoints=[
            dict(seconds=c, share_of_replies_posted=ratio(sum(sum(x <= c for x in v["follow"]) for v in sub), total),
                 share_of_conversations_with_no_later_reply=ratio(sum(max(v["follow"]) <= c for v in sub), len(sub)))
            for c in cps]))
    screen = []
    for t in sorted(set(cfg.timing_tiers + cfg.quiet_tiers)):
        sub = [c for c in convs if c["S"] >= t]
        for T in cfg.root_thresholds:
            got = np.array([c["direct"][T - 1] for c in sub if len(c["direct"]) >= T])
            screen.append(dict(tier=t, direct_replies=T, share_reaching_by_size_horizon=ratio(len(got), len(sub)),
                               median_hours=(float(np.median(got)) / 3600 if len(got) else None),
                               p90_hours=(float(np.quantile(got, 0.9)) / 3600 if len(got) else None)))
    caps = []
    for cap in cfg.caps_posts_per_30_days:
        best = None
        for s in range(2, (max(hist) + 2) if hist else 2):   # every integer cutoff, smallest first; none without data
            p = sum(k * n for k, n in hist.items() if k >= s)
            if p * per30 * (1 + cfg.overhead_fraction) <= cap:
                best = s
                break
        sub = [c for c in convs if best is not None and c["S"] >= best]
        p = sum(c["S"] for c in sub)
        caps.append(dict(cap_posts_per_30_days=cap, smallest_cutoff=best, no_conversation_fits=bool(convs and not sub),
                         conversations=len(sub), posts=p,
                         posts_per_30_days=p * per30, share_of_replies=ratio(p - len(sub), replies)))
    return dict(population=dict(roots_in_window=int(roots_in_window), conversations=n_conv,
                                roots_with_no_reply_by_size_horizon=int(roots_in_window) - n_conv,
                                share_of_roots_with_a_reply=ratio(n_conv, int(roots_in_window)), replies=replies,
                                posts_in_conversations=posts, largest_conversation=(max(hist) if hist else None),
                                window_days=(b - a) / DAY),
                volume_by_size=volume, quiet_roots=quiet, timing=timing, root_screen=screen, cutoff_for_cap=caps,
                size_histogram=dict(size=sorted(hist), conversations=[hist[s] for s in sorted(hist)]))


def same(x, y, path=""):
    """Deep comparison; floats to 1e-12 relative."""
    if isinstance(x, dict):
        assert isinstance(y, dict) and set(x) == set(y), f"{path}: keys {sorted(x)} != {sorted(y)}"
        for k in x:
            same(x[k], y[k], f"{path}/{k}")
    elif isinstance(x, (list, tuple)):
        assert len(x) == len(y), f"{path}: lengths {len(x)} != {len(y)}"
        for i, (p, q) in enumerate(zip(x, y)):
            same(p, q, f"{path}[{i}]")
    elif isinstance(x, float) or isinstance(y, float):
        assert x is not None and y is not None and math.isclose(x, y, rel_tol=1e-12, abs_tol=1e-12), f"{path}: {x} != {y}"
    else:
        assert x == y, f"{path}: {x!r} != {y!r}"


def compute(buckets, design, intake_settings):
    icfg = intake.IntakeConfig.from_dict(intake_settings)
    cfg = design_stats.DesignConfig.from_dict(design, icfg)
    acc = design_stats.Accumulator(cfg)
    for z in buckets:
        acc.add_bucket(z)
    out = acc.result()
    ref = reference(buckets, cfg)
    return out, ref


def agree(out, ref):
    same({k: v for k, v in out.items() if k in ref}, ref)
    assert set(out) - set(ref) == {"settings", "checkpoints_used_seconds", "notes"}


class ByHand(unittest.TestCase):
    def setUp(self):
        d = DAY
        self.trees = [
            # A: a chain of four posts; the last reply comes on day 40, after the size horizon
            (1 * d, [-1, 0, 1, 2], [0, 1 * d, 2 * d, 40 * d]),
            # B: a star with three direct replies at 1 h, 2 h and 10 days
            (2 * d, [-1, 0, 0, 0], [0, 3600, 7200, 10 * d]),
            # C: post 2 is dated before its parent (day 5 under a parent of day 31): it is present only
            #    from day 31, so neither counts toward the 30-day size; post 3 is a direct reply on day 3
            (3 * d, [-1, 0, 1, 0], [0, 31 * d, 5 * d, 3 * d]),
            # D: root in the window, only reply on day 45: no conversation at the 30-day horizon
            (4 * d, [-1, 0], [0, 45 * d]),
            # E: root outside the window
            (35 * d, [-1, 0, 0], [0, 60, 120]),
        ]
        self.design = dict(window=[0.0, 30 * d], size_horizon_seconds=30 * d, follow_up_seconds=90 * d,
                           size_grid=[2, 3, 4], timing_tiers=[2, 3], quiet_tiers=[2], quiet_root_max=1,
                           root_thresholds=[1, 3], checkpoints_seconds=[d, 30 * d, 90 * d])

    def test_known_answers(self):
        out, ref = compute([bucket(self.trees, zero_reply_root_times=[5 * DAY, 6 * DAY, 50 * DAY])], self.design, INTAKE)
        agree(out, ref)
        pop = out["population"]
        # roots in the window: A, B, C, D and two with no reply at all
        self.assertEqual(pop["roots_in_window"], 6)
        # 30-day sizes: A = 3 (the day-40 reply is out), B = 4, C = 2 (root and the day-3 reply), D = 1
        self.assertEqual(out["size_histogram"], dict(size=[2, 3, 4], conversations=[1, 1, 1]))
        self.assertEqual((pop["conversations"], pop["replies"], pop["roots_with_no_reply_by_size_horizon"]), (3, 6, 3))
        v = {r["s"]: r for r in out["volume_by_size"]}
        self.assertEqual([v[s]["posts"] for s in (2, 3, 4)], [9, 7, 4])
        self.assertAlmostEqual(v[3]["share_of_replies"], 5 / 6)
        q = out["quiet_roots"][0]
        # root degrees at day 30: A 1, B 3, C 1; single chains: A and C
        self.assertAlmostEqual(q["share_root_degree_at_most"]["share"], 2 / 3)
        self.assertEqual(q["median_root_degree"], 1.0)
        self.assertAlmostEqual(q["share_single_chains"], 2 / 3)
        t2 = out["timing"][0]
        # replies within 90 days: A 3, B 3, C 3 (posts 1 and 2 are present from day 31)
        self.assertEqual(t2["replies_within_follow_up"], 9)
        by = {c["seconds"]: c for c in t2["checkpoints"]}
        self.assertAlmostEqual(by[DAY]["share_of_replies_posted"], 3 / 9)      # A's first reply and B's first two
        self.assertAlmostEqual(by[30 * DAY]["share_of_replies_posted"], 6 / 9)
        self.assertAlmostEqual(by[30 * DAY]["share_of_conversations_with_no_later_reply"], 1 / 3)   # only B is finished
        self.assertAlmostEqual(by[90 * DAY]["share_of_conversations_with_no_later_reply"], 1.0)
        s = {(r["tier"], r["direct_replies"]): r for r in out["root_screen"]}
        self.assertAlmostEqual(s[(2, 1)]["share_reaching_by_size_horizon"], 1.0)
        self.assertAlmostEqual(s[(2, 1)]["median_hours"], 24.0)                # first direct reply: 1 d, 1 h, 3 d
        self.assertAlmostEqual(s[(2, 3)]["share_reaching_by_size_horizon"], 1 / 3)
        self.assertAlmostEqual(s[(2, 3)]["median_hours"], 240.0)

    def test_a_window_without_full_follow_up_is_refused(self):
        make = lambda design, **kw: design_stats.DesignConfig.from_dict(design, intake.IntakeConfig.from_dict(dict(INTAKE, **kw)))
        make(self.design, observation_end=120 * DAY)                    # day 30 + 90 days: just enough
        with self.assertRaises(ValueError):
            make(self.design, observation_end=119 * DAY)
        # trees cut at 90 days by the intake step: it dropped roots without 90 days, whatever is asked here
        short = dict(self.design, follow_up_seconds=30 * DAY, checkpoints_seconds=[DAY])
        make(short, observation_end=100 * DAY)
        with self.assertRaises(ValueError):
            make(short, observation_end=100 * DAY, horizon_seconds=90 * DAY)

    def test_monthly_scaling(self):
        half = dict(self.design, window=[0.0, 15 * DAY])                # the same four roots in half the time
        out, ref = compute([bucket(self.trees)], half, INTAKE)
        agree(out, ref)
        v = {r["s"]: r for r in out["volume_by_size"]}
        self.assertEqual((v[2]["posts"], v[2]["posts_per_30_days"]), (9, 18.0))

    def test_empty_inputs_and_empty_tiers(self):
        out, ref = compute([bucket([]), bucket(self.trees[-1:])], self.design, INTAKE)     # no root in the window
        agree(out, ref)
        self.assertEqual(out["population"]["conversations"], 0)
        self.assertIsNone(out["population"]["share_of_roots_with_a_reply"])
        bare = dict(self.design, timing_tiers=[], quiet_tiers=[], root_thresholds=[])
        out, ref = compute([bucket(self.trees)], bare, INTAKE)
        agree(out, ref)
        self.assertEqual((out["timing"], out["quiet_roots"], out["root_screen"]), ([], [], []))
        self.assertEqual(out["volume_by_size"][0]["posts"], 9)

    def test_caps(self):
        design = dict(self.design, caps_posts_per_30_days=[3.9, 4.0, 7.0, 9.0, 100.0], overhead_fraction=0.0)
        out, ref = compute([bucket(self.trees)], design, INTAKE)
        same(out["cutoff_for_cap"], ref["cutoff_for_cap"])
        # V(2) = 9, V(3) = 7, V(4) = 4, V(5) = 0: under a cap of 3.9 only an empty selection fits
        self.assertEqual([c["smallest_cutoff"] for c in out["cutoff_for_cap"]], [5, 4, 3, 2, 2])
        self.assertEqual([c["no_conversation_fits"] for c in out["cutoff_for_cap"]], [True, False, False, False, False])
        none, ref = compute([bucket([])], design, INTAKE)
        agree(none, ref)
        self.assertEqual([c["smallest_cutoff"] for c in none["cutoff_for_cap"]], [None] * 5)

    def test_settings_are_checked(self):
        icfg = intake.IntakeConfig.from_dict(INTAKE)
        make = lambda **kw: design_stats.DesignConfig.from_dict({**self.design, **kw}, icfg)
        for bad in (dict(window=[0.0, 61 * DAY]), dict(follow_up_seconds=10 * DAY), dict(size_grid=[1, 2]),
                    dict(caps_posts_per_30_days=[1000.0]), dict(typo=1)):
            with self.assertRaises(ValueError, msg=str(bad)):
                make(**bad)
        with self.assertRaises(ValueError):
            design_stats.DesignConfig.from_dict({k: v for k, v in self.design.items() if k != "follow_up_seconds"}, icfg)
        cut = intake.IntakeConfig.from_dict(dict(INTAKE, horizon_seconds=30 * DAY))
        with self.assertRaises(ValueError):                 # trees cut at 30 days cannot give 90 days of follow-up
            design_stats.DesignConfig.from_dict(self.design, cut)


class ThroughIntake(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records, _, _ = synthetic.make_records(P, 6000, 31, cohort_end=60 * DAY, mean_delay=6 * DAY,
                                                   n_zero_reply_roots=700, n_duplicates=40, n_deleted_replies=80)

    def build(self, tmp, **settings):
        cfg = intake.IntakeConfig.from_dict(dict(INTAKE, **settings))
        intake.partition(iter(self.records), tmp, cfg, dict(source="synthetic"))
        intake.build_all(tmp, cfg)
        return [dict(z) for _, z in intake.iter_tree_files(tmp)], dict(INTAKE, **settings)

    def test_matches_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            buckets, settings = self.build(tmp)
            out, ref = compute(buckets, DESIGN, settings)
        agree(out, ref)
        pop = out["population"]
        self.assertGreater(pop["conversations"], 1000)
        self.assertGreater(out["timing"][0]["checkpoints"][3]["share_of_replies_posted"], 0.5)
        self.assertLess(out["timing"][0]["checkpoints"][3]["share_of_replies_posted"], 0.999)   # the horizon binds
        self.assertEqual(out["checkpoints_used_seconds"], [3600.0, DAY, 7 * DAY, 30 * DAY, 90 * DAY])

    def test_sizes_agree_with_an_intake_run_cut_at_the_same_horizon(self):
        design = dict(DESIGN, follow_up_seconds=30 * DAY, checkpoints_seconds=[DAY, 30 * DAY])
        with tempfile.TemporaryDirectory() as t1, tempfile.TemporaryDirectory() as t2:
            as_collected, s1 = self.build(t1)
            cut, s2 = self.build(t2, horizon_seconds=30 * DAY)
            x, _ = compute(as_collected, design, s1)
            y, _ = compute(cut, design, s2)
            # and directly: the sizes the intake step wrote for the cut trees
            direct = Counter()
            for z in cut:
                m = (z["root_time"] >= 0) & (z["root_time"] < 30 * DAY)
                direct.update(np.diff(z["offsets"])[m].tolist())
        for k in ("population", "volume_by_size", "quiet_roots", "timing", "root_screen", "size_histogram"):
            same(x[k], y[k], k)
        self.assertEqual(dict(zip(y["size_histogram"]["size"], y["size_histogram"]["conversations"])), dict(direct))

    def test_bucket_layout_does_not_matter(self):
        with tempfile.TemporaryDirectory() as t1, tempfile.TemporaryDirectory() as t2:
            a, s1 = self.build(t1)
            b, s2 = self.build(t2, n_buckets=11)
            x, _ = compute(a, DESIGN, s1)
            y, _ = compute(b, DESIGN, s2)
        for k in ("population", "volume_by_size", "quiet_roots", "timing", "root_screen", "cutoff_for_cap", "size_histogram"):
            same(x[k], y[k], k)


class CommandLine(unittest.TestCase):
    def test_design_stats_command(self):
        recs, _, _ = synthetic.make_records(P, 3000, 5, cohort_end=60 * DAY, mean_delay=6 * DAY, n_zero_reply_roots=300)

        def cli(*a):
            return subprocess.run([sys.executable, "-m", "replytree2024.cli", *a], cwd=HERE.parent, capture_output=True, text=True)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            with open(tmp / "posts.tsv", "w") as fh:
                fh.write("id\tin_reply_to\tconversation\tt\tuser\n")
                fh.writelines("\t".join(map(str, r)) + "\n" for r in recs)
            cfg = dict(
                workdir=str(tmp / "work"),
                input=dict(format="delimited", paths=[str(tmp / "posts.tsv")], delimiter="\t", header=True, time_scale=1.0,
                           quotechar=None,
                           fields=dict(post_id="id", parent_id="in_reply_to", root_id="conversation", time="t", author="user")),
                intake=INTAKE, design_stats=dict(DESIGN, window=[0.0, 20 * DAY]),
                blocks=dict(training=[0.0, 20 * DAY], development=[20 * DAY, 40 * DAY], final=[40 * DAY, 60 * DAY]))
            run = tmp / "run.json"
            run.write_text(json.dumps(cfg))
            r = cli("design-stats", "--config", str(run))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("intake", r.stderr)                 # nothing to read before the intake step
            self.assertEqual(cli("intake", "--config", str(run)).returncode, 0)
            work = tmp / "work"
            # a request for statistics never declares the final block itself
            r = cli("design-stats", "--config", str(run))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("declare-final-block", r.stderr)
            self.assertFalse((work / "final_block.json").exists())
            self.assertFalse((work / "design_stats_access.log").exists())
            self.assertEqual(cli("declare-final-block", "--config", str(run)).returncode, 0)
            self.assertEqual(cli("declare-final-block", "--config", str(run)).returncode, 0)      # repeating it is harmless
            r = cli("design-stats", "--config", str(run))
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            out = json.loads((work / "design_stats" / f"design_stats_0_{20 * DAY:.0f}.json").read_text())
            self.assertEqual(out["final_block"]["overlapped_by_these_statistics"], False)
            self.assertNotIn("size_histogram", out)
            rows = (work / "design_stats" / f"size_histogram_0_{20 * DAY:.0f}.csv").read_text().splitlines()
            self.assertEqual(rows[0], "size,conversations")
            self.assertEqual(sum(int(x.split(",")[1]) for x in rows[1:]), out["population"]["conversations"])
            log = (work / "design_stats_access.log").read_text().splitlines()
            self.assertEqual(len(log), 2)                     # one line before the trees are read, one after
            self.assertTrue(" started " in log[0] and " finished " in log[1])
            # no identifiers leave: the output holds numbers and setting names only
            text = (work / "design_stats" / f"design_stats_0_{20 * DAY:.0f}.json").read_text()
            self.assertFalse(any(tok in text for tok in ("c12", "u12_", "z5")))
            # a window that reaches into the final block is refused, then logged when unlocked
            late = dict(cfg, design_stats=dict(DESIGN, window=[30 * DAY, 50 * DAY]))
            (tmp / "late.json").write_text(json.dumps(late))
            r = cli("design-stats", "--config", str(tmp / "late.json"))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("final block", r.stderr)
            self.assertFalse((work / "final_block_access.log").exists())
            self.assertEqual(cli("design-stats", "--config", str(tmp / "late.json"), "--unlock-final").returncode, 0)
            self.assertEqual(len((work / "final_block_access.log").read_text().splitlines()), 1)
            self.assertEqual(len((work / "design_stats_access.log").read_text().splitlines()), 4)
            # different intake settings from those the trees were built with are refused
            other = dict(cfg, intake=dict(INTAKE, horizon_seconds=120 * DAY))
            (tmp / "other.json").write_text(json.dumps(other))
            r = cli("design-stats", "--config", str(tmp / "other.json"))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("different intake settings", r.stderr)
            # the final block is declared once: moving it, or leaving it out, does not open it
            before = (work / "design_stats_access.log").read_text()
            moved = dict(late, blocks=dict(cfg["blocks"], final=[50 * DAY, 60 * DAY]))
            (tmp / "moved.json").write_text(json.dumps(moved))
            r = cli("design-stats", "--config", str(tmp / "moved.json"))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("different final block", r.stderr)
            self.assertNotEqual(cli("declare-final-block", "--config", str(tmp / "moved.json")).returncode, 0)
            self.assertEqual(json.loads((work / "final_block.json").read_text())["final"], [40 * DAY, 60 * DAY])
            (tmp / "none.json").write_text(json.dumps({k: v for k, v in late.items() if k != "blocks"}))
            r = cli("design-stats", "--config", str(tmp / "none.json"))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("blocks", r.stderr)
            # an altered or missing tree file stops the run before anything is read or logged
            victim = sorted((work / "trees").glob("b*.npz"))[0]
            original = victim.read_bytes()
            victim.write_bytes(original + b"x")
            r = cli("design-stats", "--config", str(run))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("does not match", r.stderr)
            victim.unlink()
            r = cli("design-stats", "--config", str(run))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("missing", r.stderr)
            victim.write_bytes(original)
            self.assertEqual((work / "design_stats_access.log").read_text(), before)
            # a run that fails after it has started leaves a record of the failure
            ledger = (work / "ledger.json").read_text()
            (work / "ledger.json").write_text("{}")
            self.assertNotEqual(cli("design-stats", "--config", str(run)).returncode, 0)
            self.assertIn(" failed (KeyError) ", (work / "design_stats_access.log").read_text().splitlines()[-1])
            (work / "ledger.json").write_text(ledger)
            self.assertEqual(len((work / "final_block_access.log").read_text().splitlines()), 1)
            self.assertEqual(cli("design-stats", "--config", str(run)).returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
