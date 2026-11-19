"""Tests of the intake path on synthetic records with known defects."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from replytree2024 import g18, intake, synthetic  # noqa: E402

P = g18.G18Parameters.from_dict(json.loads((HERE.parent / "fixtures" / "trees_v1.json").read_text())
                                ["g18_parameters"]["mc_check"])
DAY = 86400.0
BASE = dict(cohort_start=0.0, cohort_end=30 * DAY, observation_end=400 * DAY, horizon_seconds=None,
            missing_parent_rule="drop_subtree", reply_before_parent_rule="keep", cycle_rule="quarantine_tree",
            n_buckets=7, max_bucket_records=10_000_000, max_malformed_records=0)


def canon(parents):
    kids = {}
    for j, p in enumerate(parents):
        kids.setdefault(p, []).append(j)

    def enc(v):
        return "(" + "".join(sorted(enc(c) for c in kids.get(v, []))) + ")"
    return enc(0)


def run(records, cfg, tmp, manifest="synthetic"):
    part = intake.partition(iter(records), tmp, cfg, dict(source=manifest))
    ledger = intake.build_all(tmp, cfg)
    ledger["_partition"] = part
    trees = {}
    for _, z in intake.iter_tree_files(tmp):
        for i, rid in enumerate(z["tree_id"]):
            trees[str(rid)] = z["parents"][z["offsets"][i]:z["offsets"][i + 1]].tolist()
    return ledger, trees


class Config(unittest.TestCase):
    def test_fails_closed(self):
        for k in intake.REQUIRED:
            d = dict(BASE); d.pop(k)
            with self.assertRaises(ValueError):
                intake.IntakeConfig.from_dict(d)
        with self.assertRaises(ValueError):
            intake.IntakeConfig.from_dict({**BASE, "missing_parent_rule": "guess"})
        with self.assertRaises(ValueError):
            intake.IntakeConfig.from_dict({**BASE, "horizon_seconds": -1})
        for k, bad in (("horizon_seconds", float("inf")), ("observation_end", float("nan")),
                       ("cohort_start", float("-inf")), ("cohort_end", "tomorrow")):
            with self.assertRaises(ValueError):
                intake.IntakeConfig.from_dict({**BASE, k: bad})


class CleanData(unittest.TestCase):
    def test_trees_are_recovered_exactly(self):
        recs, truth, _ = synthetic.make_records(P, 3000, 1)
        with tempfile.TemporaryDirectory() as tmp:
            ledger, trees = run(recs, intake.IntakeConfig.from_dict(BASE), tmp)
        self.assertEqual(set(trees), set(truth))
        for rid, t in truth.items():
            self.assertEqual(canon(trees[rid]), canon(t["parents"]))
        self.assertEqual(ledger["conversations_kept"], len(truth))
        self.assertEqual(ledger["posts_kept"], sum(len(t["parents"]) for t in truth.values()))
        self.assertEqual(ledger.get("exact_duplicate_records_dropped", 0), 0)

    def test_restart_skips_finished_buckets(self):
        recs, truth, _ = synthetic.make_records(P, 500, 2)
        cfg = intake.IntakeConfig.from_dict(BASE)
        with tempfile.TemporaryDirectory() as tmp:
            l1, _ = run(recs, cfg, tmp)
            l1.pop("_partition")
            stamps = {f.name: f.stat().st_mtime_ns for f in (Path(tmp) / "trees").glob("*.npz")}
            l2 = intake.build_all(tmp, cfg)
            self.assertEqual(l1, l2)
            self.assertEqual(stamps, {f.name: f.stat().st_mtime_ns for f in (Path(tmp) / "trees").glob("*.npz")})

    def test_restart_is_bound_to_inputs_and_settings(self):
        recs, _, _ = synthetic.make_records(P, 300, 2)
        cfg = intake.IntakeConfig.from_dict(BASE)
        with tempfile.TemporaryDirectory() as tmp:
            run(recs, cfg, tmp)
            with self.assertRaises(intake.IntakeError):          # other input, same directory
                intake.partition(iter(recs), tmp, cfg, dict(source="another file"))
            with self.assertRaises(intake.IntakeError):          # other horizon, same directory
                intake.build_all(tmp, intake.IntakeConfig.from_dict({**BASE, "horizon_seconds": 3600.0,
                                                                     "observation_end": 400 * DAY}))

    def test_a_tampered_bucket_is_rebuilt(self):
        recs, _, _ = synthetic.make_records(P, 300, 2)
        cfg = intake.IntakeConfig.from_dict(BASE)
        with tempfile.TemporaryDirectory() as tmp:
            l1, t1 = run(recs, cfg, tmp)
            victim = sorted((Path(tmp) / "trees").glob("*.npz"))[0]
            good = intake.file_sha256(victim)
            victim.write_bytes(b"not an archive")
            intake.build_all(tmp, cfg)
            self.assertEqual(intake.file_sha256(victim), good)

    def test_result_does_not_depend_on_record_order(self):
        recs, _, _ = synthetic.make_records(P, 800, 4, n_duplicates=50, n_deleted_replies=40)
        cfg = intake.IntakeConfig.from_dict(BASE)
        outs = []
        for seed in (0, 1):
            order = np.random.default_rng(seed).permutation(len(recs))
            with tempfile.TemporaryDirectory() as tmp:
                run([recs[k] for k in order], cfg, tmp)
                outs.append({f.name: {k: z[k].tolist() for k in z.files} for f, z in intake.iter_tree_files(tmp)})
        self.assertEqual(outs[0], outs[1])


class Defects(unittest.TestCase):
    def setUp(self):
        self.recs, self.truth, self.info = synthetic.make_records(
            P, 4000, 3, n_zero_reply_roots=250, n_roots_before_cohort=120, n_duplicates=300,
            n_deleted_replies=200, n_missing_root_records=40)

    def test_ledger_matches_injected_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger, trees = run(self.recs, intake.IntakeConfig.from_dict(BASE), tmp)
        self.assertEqual(ledger["exact_duplicate_records_dropped"], 300)
        self.assertEqual(ledger["conversations_without_root_record"], 40)
        # roots before the cohort window, except those whose root record was itself removed
        before = sum(1 for rid, t in self.truth.items() if t["root_time"] < 0 and rid not in self.info["missing_root"])
        self.assertEqual(ledger["roots_outside_cohort_window"], before)
        # every record is accounted for: read = kept + each named reason
        read = len(self.recs)
        accounted = (ledger["posts_kept"] + ledger["exact_duplicate_records_dropped"]
                     + ledger["posts_in_conversations_without_root_record"]
                     + ledger["posts_under_roots_outside_cohort_window"]
                     + ledger.get("posts_dropped_under_missing_parent", 0))
        self.assertEqual(read, accounted)
        self.assertGreaterEqual(ledger["kept_roots_with_no_reply"], 250)

    def test_untouched_conversations_are_exact_and_deletions_only_remove_subtrees(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, trees = run(self.recs, intake.IntakeConfig.from_dict(BASE), tmp)
        deleted_roots = {d.split("_")[0] for d in self.info["deleted"]}
        for rid, t in self.truth.items():
            if rid in self.info["missing_root"] or t["root_time"] < 0:
                self.assertNotIn(rid, trees)
            elif rid not in deleted_roots:
                self.assertEqual(canon(trees[rid]), canon(t["parents"]))
            elif rid in trees:
                self.assertLess(len(trees[rid]), len(t["parents"]))

    def test_missing_parent_rules(self):
        kept = {}
        for rule in intake.MISSING_PARENT_RULES:
            with tempfile.TemporaryDirectory() as tmp:
                ledger, trees = run(self.recs, intake.IntakeConfig.from_dict({**BASE, "missing_parent_rule": rule}), tmp)
            kept[rule] = (ledger["conversations_kept"], ledger["posts_kept"])
        self.assertLess(kept["quarantine_tree"][0], kept["drop_subtree"][0])
        self.assertEqual(kept["drop_subtree"][0], kept["attach_to_root"][0])
        self.assertLess(kept["drop_subtree"][1], kept["attach_to_root"][1])

    def test_horizon_truncates_and_requires_follow_up(self):
        H = 2 * 3600.0
        cfg = intake.IntakeConfig.from_dict({**BASE, "horizon_seconds": H, "observation_end": 30 * DAY})
        recs, truth, _ = synthetic.make_records(P, 2000, 5)
        with tempfile.TemporaryDirectory() as tmp:
            ledger, trees = run(recs, cfg, tmp)
        late = sum(1 for t in truth.values() if t["root_time"] + H > 30 * DAY)
        self.assertEqual(ledger.get("roots_without_full_horizon_of_follow_up", 0), late)
        for rid, t in truth.items():
            if t["root_time"] + H > 30 * DAY:
                self.assertNotIn(rid, trees)
                continue
            # expected tree: posts reachable from the root through posts within the horizon
            keep = [0]
            ok = {0}
            for j in range(1, len(t["parents"])):
                if t["parents"][j] in ok and t["times"][j] <= H:
                    ok.add(j); keep.append(j)
            if len(keep) == 1:
                self.assertNotIn(rid, trees)
            else:
                remap = {v: i for i, v in enumerate(keep)}
                expect = [-1] + [remap[t["parents"][j]] for j in keep[1:]]
                self.assertEqual(canon(trees[rid]), canon(expect))


class Adversarial(unittest.TestCase):
    """Defects that must never be resolved by the order of the input."""

    def base_records(self):
        # one clean conversation r1 (root, a, b under a) and one clean conversation r2
        return [("r1", "", "r1", 10.0, "u1"), ("a", "r1", "r1", 20.0, "u2"), ("b", "a", "r1", 30.0, "u1"),
                ("r2", "", "r2", 15.0, "u3"), ("c", "r2", "r2", 25.0, "u4")]

    def go(self, recs, **over):
        cfg = intake.IntakeConfig.from_dict({**BASE, "n_buckets": 3, **over})
        with tempfile.TemporaryDirectory() as tmp:
            ledger, trees = run(recs, cfg, tmp)
            files = [dict(z) for _, z in intake.iter_tree_files(tmp)]
        return ledger, trees, files

    def test_conflicting_duplicate_quarantines_whatever_the_order(self):
        extra = ("b", "r1", "r1", 30.0, "u1")                  # same post id, different parent
        for recs in (self.base_records() + [extra], [extra] + self.base_records()):
            ledger, trees, _ = self.go(recs)
            self.assertNotIn("r1", trees)
            self.assertIn("r2", trees)
            self.assertEqual(ledger["conversations_quarantined_conflicting_duplicate"], 1)

    def test_post_id_under_two_conversations_quarantines_both(self):
        ledger, trees, _ = self.go(self.base_records() + [("a", "r2", "r2", 40.0, "u9")])
        self.assertEqual(trees, {})
        self.assertEqual(ledger["conversations_quarantined_post_id_shared_with_another"], 2)

    def test_cycle_is_named_and_follows_the_declared_rule(self):
        cyc = [("x", "y", "r1", 40.0, "u5"), ("y", "x", "r1", 41.0, "u6")]
        ledger, trees, _ = self.go(self.base_records() + cyc)
        self.assertNotIn("r1", trees)
        self.assertEqual(ledger["conversations_quarantined_cycle"], 1)
        ledger, trees, _ = self.go(self.base_records() + cyc, cycle_rule="drop_component")
        self.assertEqual(trees["r1"], [-1, 0, 1])
        self.assertEqual(ledger["posts_dropped_in_cycle_components"], 2)

    def test_nonfinite_time_quarantines(self):
        ledger, trees, _ = self.go(self.base_records() + [("d", "r1", "r1", float("nan"), "u7")])
        self.assertNotIn("r1", trees)
        self.assertEqual(ledger["conversations_quarantined_nonfinite_time"], 1)

    def test_reply_after_observation_end_is_dropped_and_counted(self):
        late = [("d", "a", "r1", 500 * DAY, "u7"), ("e", "d", "r1", 501 * DAY, "u8")]
        ledger, trees, _ = self.go(self.base_records() + late)
        self.assertEqual(trees["r1"], [-1, 0, 1])
        self.assertEqual(ledger["posts_dropped_after_observation_end_or_under_one"], 2)

    def test_missing_author_is_not_an_extra_author(self):
        recs = [("r1", "", "r1", 10.0, "u1"), ("a", "r1", "r1", 20.0, ""), ("b", "a", "r1", 30.0, "u1"),
                ("r2", "", "r2", 15.0, "u3"), ("c", "r2", "r2", 25.0, "u3")]
        ledger, trees, files = self.go(recs)
        by = {}
        for z in files:
            for i, rid in enumerate(z["tree_id"]):
                by[str(rid)] = (int(z["n_authors"][i]), int(z["n_posts_without_author"][i]),
                                z["author"][z["offsets"][i]:z["offsets"][i + 1]].tolist())
        self.assertEqual(by["r1"][:2], (1, 1))
        self.assertEqual(by["r1"][2][1], -1)
        self.assertEqual(by["r1"][2][0], by["r1"][2][2])        # the same author keeps the same pseudonym
        self.assertEqual(ledger["kept_conversations_with_some_author_missing"], 1)
        self.assertEqual(ledger["kept_conversations_with_one_author"], 1)

    def test_root_table_keeps_roots_with_no_reply(self):
        recs = self.base_records() + [("z1", "", "z1", 12.0, "u9")]
        ledger, trees, files = self.go(recs)
        roots = {str(r): (float(t), int(s)) for z in files
                 for r, t, s in zip(z["all_root_id"], z["all_root_time"], z["all_root_size"])}
        self.assertEqual(roots, {"r1": (10.0, 3), "r2": (15.0, 2), "z1": (12.0, 1)})
        self.assertNotIn("z1", trees)

    def test_oversized_bucket_stops_the_run(self):
        with self.assertRaises(intake.IntakeError):
            self.go(self.base_records(), n_buckets=1, max_bucket_records=3)

    def test_malformed_rows_are_counted_or_stop_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "in.tsv"
            f.write_text("id\tparent\troot\tt\tuser\nr1\t\tr1\t10\tu1\na\tr1\tr1\tnot-a-time\tu2\nb\tr1\tr1\n")
            fields = dict(post_id="id", parent_id="parent", root_id="root", time="t", author="user")
            rows = list(intake.read_delimited(f, fields, "\t", True, 1.0, None))
            self.assertEqual(sum(isinstance(r, intake.Malformed) for r in rows), 2)
            cfg = intake.IntakeConfig.from_dict({**BASE, "n_buckets": 2, "max_malformed_records": 5})
            part = intake.partition(iter(rows), Path(tmp) / "w1", cfg, dict(source="x"))
            self.assertEqual(part["malformed_records"], 2)
            strict = intake.IntakeConfig.from_dict({**BASE, "n_buckets": 2})
            with self.assertRaises(intake.IntakeError):
                intake.partition(iter(rows), Path(tmp) / "w2", strict, dict(source="x"))

    def test_json_null_ids_stay_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "in.jsonl"
            f.write_text('{"id": null, "p": null, "c": "r1", "t": 1, "u": "a"}\n'
                         '{"id": "r1", "p": null, "c": null, "t": 1, "u": null}\n'
                         '{"id": "r2", "p": null, "c": "r2", "t": 2, "u": null}\n')
            rows = list(intake.read_jsonl(f, dict(post_id="id", parent_id="p", root_id="c", time="t", author="u"), 1.0))
            self.assertEqual(rows[0][0], "")
            self.assertEqual(rows[1][2], "")
            self.assertEqual(rows[2], ("r2", "", "r2", 2.0, ""))
            cfg = intake.IntakeConfig.from_dict({**BASE, "n_buckets": 2})
            part = intake.partition(iter(rows), Path(tmp) / "w", cfg, dict(source="x"))
            self.assertEqual(part["records_without_post_or_root_id"], 2)
            self.assertEqual(part["records_written_to_buckets"], 1)

    def test_missing_or_altered_bucket_is_detected(self):
        cfg = intake.IntakeConfig.from_dict({**BASE, "n_buckets": 3})
        for damage in ("delete", "alter"):
            with tempfile.TemporaryDirectory() as tmp:
                intake.partition(iter(self.base_records()), tmp, cfg, dict(source="x"))
                victim = sorted((Path(tmp) / "buckets").glob("b*.jsonl"))[0]
                if damage == "delete":
                    victim.unlink()
                else:
                    victim.write_text(victim.read_text() + json.dumps(["r1", "zz", "r1", 99.0, "u"]) + "\n")
                with self.assertRaises(intake.IntakeError):
                    intake.build_all(tmp, cfg)

    def test_dispositions_are_disjoint_and_complete(self):
        # an exact duplicate AND a conflicting duplicate in one conversation, plus a clean one
        recs = self.base_records() + [("a", "r1", "r1", 20.0, "u2"), ("b", "r1", "r1", 30.0, "u1")]
        ledger, trees, _ = self.go(recs)
        disp = {k: v for k, v in ledger.items() if isinstance(k, str) and k.startswith("disposition: ")}
        self.assertEqual(sum(disp.values()), len(recs))
        self.assertEqual(disp["disposition: conversation quarantined, conflicting duplicate"], 5)
        self.assertEqual(disp["disposition: post kept"], 2)
        # the overlapping diagnostic counters still report both events
        self.assertEqual(ledger["exact_duplicate_records_dropped"], 1)
        self.assertEqual(ledger["duplicate_records_with_conflicting_content"], 1)

    def test_oversized_post_index_stops_the_run(self):
        cfg = intake.IntakeConfig.from_dict({**BASE, "n_buckets": 1, "max_bucket_records": 4})
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(intake.IntakeError):
                intake.partition(iter(self.base_records()), tmp, cfg, dict(source="x"))

    def test_quoted_field_with_embedded_separator_is_read_losslessly(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "in.csv"
            f.write_text('id,parent,root,t,user\nr1,,r1,10,"name, with comma"\n')
            fields = dict(post_id="id", parent_id="parent", root_id="root", time="t", author="user")
            rows = list(intake.read_delimited(f, fields, ",", True, 1.0, '"'))
            self.assertEqual(rows, [("r1", "", "r1", 10.0, "name, with comma")])


if __name__ == "__main__":
    unittest.main(verbosity=2)
