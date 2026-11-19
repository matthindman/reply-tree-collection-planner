"""Worked example: simulate conversations from known parameters, then estimate the parameters back.

    python3 example/run_example.py                 (run from the estimation/ folder)
    python3 example/run_example.py --trees 40000 --out my_work_dir

It writes a file of invented post records (posts.tsv) and a configuration (run.json), runs the same
two commands a real analysis runs (intake, then fit-g18), and prints the true values beside the
estimates. Nothing here uses or says anything about real data.
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
sys.path.insert(0, str(PKG))
from replytree2024 import g18, synthetic  # noqa: E402

DAY = 86400.0
# Starting values for the optimizer. Neither is the truth; every start is kept in the output.
GENERIC = dict(c0=-1.0, c1=0.3, s1=0.5, mu=-0.5, gam=0.1, sig=0.5, tau=0.5,
               g0=-2.5, f0=-1.5, f1=0.0, alpha0=2.5, b1=0.1, b2=0.1)
STARTS = [dict(label="generic", values=GENERIC),
          dict(label="no latent effects", values={**GENERIC, "s1": 0.05, "sig": 0.05, "tau": 0.05})]


def run(*args):
    r = subprocess.run([sys.executable, "-m", "replytree2024.cli", *args], cwd=PKG, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"{' '.join(args[:1])} failed:\n{r.stdout[-1500:]}\n{r.stderr[-1500:]}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--trees", type=int, default=12000, help="conversations with at least one reply to simulate")
    ap.add_argument("--seed", type=int, default=9)
    ap.add_argument("--out", default=None, help="a new, empty folder for the files (default: a temporary folder)")
    a = ap.parse_args()
    out = Path(a.out) if a.out else Path(tempfile.mkdtemp(prefix="replytree_example_"))
    out.mkdir(parents=True, exist_ok=True)

    fixture = json.loads((PKG / "fixtures" / "trees_v1.json").read_text())["g18_parameters"]
    truth = g18.G18Parameters.from_dict(fixture["mc_check"])
    records, _, _ = synthetic.make_records(truth, a.trees, a.seed, cohort_end=90 * DAY,
                                           n_zero_reply_roots=a.trees // 15, n_duplicates=100)
    with open(out / "posts.tsv", "w") as fh:
        fh.write("id\tin_reply_to\tconversation\tt\tuser\n")
        for r in records:
            fh.write("\t".join(map(str, r)) + "\n")

    cfg = dict(
        workdir=str(out / "work"),
        input=dict(format="delimited", paths=[str(out / "posts.tsv")], delimiter="\t", header=True,
                   quotechar=None, time_scale=1.0,
                   fields=dict(post_id="id", parent_id="in_reply_to", root_id="conversation", time="t", author="user")),
        intake=dict(cohort_start=0.0, cohort_end=90 * DAY, observation_end=10000 * DAY, horizon_seconds=None,
                    missing_parent_rule="drop_subtree", reply_before_parent_rule="keep", cycle_rule="quarantine_tree",
                    n_buckets=5, max_bucket_records=10_000_000, max_malformed_records=0),
        blocks=dict(training=[0.0, 60 * DAY], development=[60 * DAY, 75 * DAY], final=[75 * DAY, 90 * DAY]),
        g18_fit=dict(fit_sample_fraction=1.0, starts=STARTS))
    (out / "run.json").write_text(json.dumps(cfg, indent=1) + "\n")

    print(f"{len(records):,} post records written to {out / 'posts.tsv'}")
    run("intake", "--config", str(out / "run.json"))
    print("intake done; fitting (about a minute)...", flush=True)
    run("fit-g18", "--config", str(out / "run.json"))
    fit = json.loads((out / "work" / "fits" / "g18_fit.json").read_text())

    print(f"\nfit status: {fit['status']}   conversations used: {fit['trees_used']:,}")
    if "parameters" not in fit:
        sys.exit(f"no estimate was produced; see {out / 'work' / 'fits' / 'g18_fit.json'}")
    est = g18.G18Parameters.from_dict(fit)

    # The 13 parameters of the reply process are compared one by one.
    print("\nreply process (13 parameters)")
    print(f"{'parameter':>10} {'true':>9} {'estimate':>9}")
    for k in g18.CONT_NAMES + g18.END_NAMES:
        print(f"{k:>10} {getattr(truth, k):9.3f} {getattr(est, k):9.3f}")

    # The 5 root parameters describe a mixture of two components. When the components overlap, as they
    # do here, different parameter values give almost the same distribution, so the distribution is
    # compared instead: the share of replied-to roots with at least k direct replies.
    k = np.arange(1, 200001, dtype=float)
    p_true, p_est = np.exp(g18.root_logpmf(k, truth)), np.exp(g18.root_logpmf(k, est))
    print("\ndirect replies to the root (5 parameters, compared as a distribution)")
    print(f"{'at least':>10} {'true':>9} {'estimate':>9}")
    for c in (2, 3, 5, 10, 30):
        print(f"{c:>10} {p_true[c - 1:].sum():9.4f} {p_est[c - 1:].sum():9.4f}")
    print("root parameters: " + "  ".join(f"{n} {getattr(est, n):.3f}" for n in g18.ROOT_NAMES)
          + "   (true: " + "  ".join(f"{n} {getattr(truth, n):.3f}" for n in g18.ROOT_NAMES) + ")")
    print(f"\nfull record of the fit: {out / 'work' / 'fits' / 'g18_fit.json'}")


if __name__ == "__main__":
    main()
