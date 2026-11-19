"""End-to-end dry run of the command line on synthetic records."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from replytree2024 import g18, synthetic  # noqa: E402

FIX = json.loads((HERE.parent / "fixtures" / "trees_v1.json").read_text())["g18_parameters"]
TRUTH = g18.G18Parameters.from_dict(FIX["mc_check"])
DAY = 86400.0


def cli(*a, expect=0):
    r = subprocess.run([sys.executable, "-m", "replytree2024.cli", *a], cwd=HERE.parent, capture_output=True, text=True)
    if r.returncode != expect:
        raise AssertionError(f"exit {r.returncode}\n{r.stdout[-800:]}\n{r.stderr[-1500:]}")
    return r


class DryRun(unittest.TestCase):
    def test_end_to_end(self):
        recs, truth, _ = synthetic.make_records(TRUTH, 12000, 9, cohort_end=90 * DAY, n_zero_reply_roots=800,
                                                n_duplicates=100, n_deleted_replies=60)
        start = {k: getattr(TRUTH, k) for k in g18.CONT_NAMES + g18.END_NAMES}
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            with open(tmp / "posts.tsv", "w") as fh:
                fh.write("id\tin_reply_to\tconversation\tt\tuser\n")
                for r in recs:
                    fh.write("\t".join(map(str, r)) + "\n")
            cfg = dict(
                workdir=str(tmp / "work"),
                input=dict(format="delimited", paths=[str(tmp / "posts.tsv")], delimiter="\t", header=True, time_scale=1.0,
                           quotechar=None,
                           fields=dict(post_id="id", parent_id="in_reply_to", root_id="conversation", time="t", author="user")),
                intake=dict(cohort_start=0.0, cohort_end=90 * DAY, observation_end=120 * DAY, horizon_seconds=30 * DAY,
                            missing_parent_rule="drop_subtree", reply_before_parent_rule="keep", cycle_rule="quarantine_tree",
                            n_buckets=5, max_bucket_records=10_000_000, max_malformed_records=0),
                blocks=dict(training=[0.0, 50 * DAY], development=[50 * DAY, 70 * DAY], final=[70 * DAY, 90 * DAY]),
                g18_fit=dict(fit_sample_fraction=1.0, starts=[dict(label="truth", values=start)]))
            (tmp / "run.json").write_text(json.dumps(cfg))
            cli("intake", "--config", str(tmp / "run.json"))
            ledger = json.loads((tmp / "work" / "ledger.json").read_text())
            self.assertEqual(ledger["build"]["exact_duplicate_records_dropped"], 100)
            self.assertEqual(ledger["partition"]["records_read"], len(recs))
            cli("fit-g18", "--config", str(tmp / "run.json"))
            fit = json.loads((tmp / "work" / "fits" / "g18_fit.json").read_text())
            self.assertTrue(fit["trees_used"] > 3000)
            cli("score-g18", "--config", str(tmp / "run.json"), "--block", "development")
            r = cli("score-g18", "--config", str(tmp / "run.json"), "--block", "final", expect=1)
            self.assertIn("refused", r.stderr)
            self.assertFalse((tmp / "work" / "final_block_access.log").exists())
            cli("score-g18", "--config", str(tmp / "run.json"), "--block", "final", "--unlock-final")
            self.assertEqual(len((tmp / "work" / "final_block_access.log").read_text().splitlines()), 1)
            cli("simulate-g18", "--config", str(tmp / "run.json"), "--n", "20000", "--seed", "4")
            sim = json.loads((tmp / "work" / "sim" / "g18_seed4.json").read_text())
            self.assertEqual(sim["trees_requested"], 20000)
            # the work directory is bound to its inputs and settings: a changed horizon is refused
            changed = json.loads(json.dumps(cfg)); changed["intake"]["horizon_seconds"] = 7 * DAY
            (tmp / "changed.json").write_text(json.dumps(changed))
            r = subprocess.run([sys.executable, "-m", "replytree2024.cli", "intake", "--config", str(tmp / "changed.json")],
                               cwd=HERE.parent, capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("different intake settings", r.stderr)
            # a missing scientific setting stops the run
            bad = dict(cfg); bad["intake"] = {k: v for k, v in cfg["intake"].items() if k != "horizon_seconds"}
            (tmp / "bad.json").write_text(json.dumps(bad))
            r = subprocess.run([sys.executable, "-m", "replytree2024.cli", "intake", "--config", str(tmp / "bad.json")],
                               cwd=HERE.parent, capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("horizon_seconds", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
