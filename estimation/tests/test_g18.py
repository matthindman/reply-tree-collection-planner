"""Tests of the G18 likelihood: statistics, numerical accuracy, generator agreement.

Run from claude/plan2024:  python3 -m unittest discover -s tests -v
"""
import json
import os
import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from replytree2024 import data, g18, reference  # noqa: E402

FIX = json.loads((HERE.parent / "fixtures" / "trees_v1.json").read_text())
TREES = FIX["trees"]
PARAMS = {k: g18.G18Parameters.from_dict(v) for k, v in FIX["g18_parameters"].items()}


def random_tree(rng, n, chainy):
    p = [-1]
    for j in range(1, n):
        p.append(j - 1 if rng.random() < chainy else int(rng.integers(0, j)))
    return p


class Stats(unittest.TestCase):
    def test_against_naive(self):
        rng = np.random.default_rng(7)
        trees = [random_tree(rng, int(rng.integers(2, 40)), rng.random()) for _ in range(300)] + TREES
        off, flat = data.flatten(trees)
        st = data.g18_stats(off, flat)
        for i, t in enumerate(trees):
            nv = data.naive_stats(t)
            self.assertEqual(int(st.K[i]), nv["K"])
            self.assertEqual(int(st.C[i]), nv["C"])
            m = st.seg_tree == i
            self.assertEqual(sorted(np.repeat(st.seg_a[m], st.seg_cnt[m]).tolist()), nv["seg_a"])
            m = st.end_tree == i
            ends = sorted(zip(np.repeat(st.end_role[m], st.end_cnt[m]).tolist(),
                              np.repeat(st.end_degree[m], st.end_cnt[m]).tolist()))
            self.assertEqual(ends, nv["ends"])

    def test_chunking_does_not_change_statistics(self):
        rng = np.random.default_rng(3)
        trees = [random_tree(rng, int(rng.integers(2, 60)), rng.random()) for _ in range(200)]
        off, flat = data.flatten(trees)
        a, b = data.g18_stats(off, flat), data.g18_stats(off, flat, chunk_posts=97)
        for k in ("K", "C", "seg_tree", "seg_a", "seg_cnt", "end_tree", "end_role", "end_degree", "end_cnt"):
            np.testing.assert_array_equal(getattr(a, k), getattr(b, k))
        for k in a.outcomes:
            np.testing.assert_array_equal(a.outcomes[k], b.outcomes[k])

    def test_every_nonroot_post_accounted(self):
        off, flat = data.flatten(TREES)
        st = data.g18_stats(off, flat)
        for i, t in enumerate(TREES):
            m = st.seg_tree == i
            n_cont = int(st.C[i]) + int((st.seg_a[m] * st.seg_cnt[m]).sum())
            n_end = int(st.end_cnt[st.end_tree == i].sum())
            self.assertEqual(n_cont + n_end, len(t) - 1)


class Accuracy(unittest.TestCase):
    def test_segment_integral(self):
        from scipy.special import logsumexp
        eps = np.linspace(-60, 60, 600001)
        h = eps[1] - eps[0]
        worst = 0.0
        for tau in (0.05, 0.4, 1.2):
            for a in (0, 1, 7, 60, 400):
                for z in (-4.0, -0.5, 2.5):
                    y = z + tau * eps
                    brute = logsumexp(-a * np.logaddexp(0, -y) - np.logaddexp(0, y) - 0.5 * eps * eps) \
                        + np.log(h) - 0.5 * np.log(2 * np.pi)
                    fast, _ = g18.log_J(a, z, tau)
                    worst = max(worst, abs(float(fast) - brute))
                    self.assertAlmostEqual(float(fast), brute, delta=1e-9, msg=f"tau={tau} a={a} z={z}")
        print(f"\n  worst |log J - brute force|: {worst:.2e}")

    def test_segment_integral_derivative(self):
        for tau in (0.0, 0.5):
            f0, d = g18.log_J(np.array([0., 3., 25.]), 0.3, tau)
            f1, _ = g18.log_J(np.array([0., 3., 25.]), 0.3 + 1e-6, tau)
            np.testing.assert_allclose((f1 - f0) / 1e-6, d, atol=2e-5)

    def test_tree_probability_against_reference(self):
        worst = 0.0
        for name, P in PARAMS.items():
            for t in TREES:
                r_fast, c_fast = g18.tree_log_probability_parts(t, P)
                r_ref, c_ref = reference.g18_reference(t, P)
                worst = max(worst, abs(c_fast - c_ref))
                self.assertAlmostEqual(r_fast, r_ref, delta=1e-12)
                self.assertAlmostEqual(c_fast, c_ref, delta=1e-8, msg=f"{name} {t}")
        print(f"\n  worst |fast - reference| over {len(PARAMS) * len(TREES)} cases: {worst:.2e}")

    def test_analytic_gradient_of_continuation_block(self):
        rng = np.random.default_rng(11)
        trees = [random_tree(rng, int(rng.integers(2, 80)), rng.random()) for _ in range(400)]
        off, flat = data.flatten(trees)
        st = data.g18_stats(off, flat)
        cd = g18.ContinuationData(st.K, st.C, st.seg_tree, st.seg_a, st.seg_cnt)
        for name in ("news_s1729", "nishi", "strong_effects"):
            P = PARAMS[name]
            ll, grad = g18.continuation_loglik(cd, P, gradient=True)
            np.testing.assert_allclose(ll, g18.continuation_loglik(cd, P), rtol=0, atol=1e-10)
            total = cd.weight @ grad
            for i, k in enumerate(g18.CONT_NAMES):
                h = 1e-5
                up = cd.weight @ g18.continuation_loglik(cd, P.replace(**{k: getattr(P, k) + h}))
                dn = cd.weight @ g18.continuation_loglik(cd, P.replace(**{k: getattr(P, k) - h}))
                fd = (up - dn) / (2 * h)
                self.assertAlmostEqual(total[i], fd, delta=1e-5 * max(1.0, abs(fd)), msg=f"{name} {k}")

    def test_batch_equals_single(self):
        P = PARAMS["news_s1729"]
        off, flat = data.flatten(TREES)
        root, cont, end = g18.batch_log_probability(data.g18_stats(off, flat), P)
        for i, t in enumerate(TREES):
            r, c = g18.tree_log_probability_parts(t, P)
            self.assertAlmostEqual(root[i], r, delta=1e-12)
            self.assertAlmostEqual(cont[i] + end[i], c, delta=1e-10)

    def test_offspring_probabilities_sum_to_one(self):
        # For fixed latent effects, P(0) + P(1) + sum_{d>=2} P(d) must be 1 at both roles.
        P = PARAMS["news_s1729"]
        d = np.arange(2, 2_000_000)
        for K in (1.0, 37.0, 5000.0):
            for role in (1, 2):
                terms = np.exp(g18._end_terms(np.full(len(d), role), np.full(len(d), K), d, P))
                leaf = np.exp(g18._end_terms(np.array([role]), np.array([K]), np.array([0]), P))[0]
                tail = None
                alpha = 1 + (P.alpha0 - 1) * K ** (-(P.b1 if role == 1 else P.b2))
                # remaining mass beyond the truncation: phi * (d_max)^(-alpha)
                phi = 1 - leaf
                self.assertAlmostEqual(leaf + terms.sum() + phi * float(d[-1]) ** (-alpha), 1.0, delta=1e-9)


class Guards(unittest.TestCase):
    def test_root_rejects_invalid_degree_and_never_floors(self):
        P = PARAMS["news_s1729"]
        for bad in (0, -1, 2.5):
            with self.assertRaises(ValueError):
                g18.root_logpmf(np.array([bad]), P)
        far = g18.root_logpmf(np.array([1e12]), P)          # tiny but representable in the log domain
        self.assertTrue(np.isfinite(far[0]) and far[0] < -100)

    def test_branch_exponent_of_one_is_a_recorded_failure(self):
        P = PARAMS["news_s1729"].replace(b1=40.0)           # alpha(K) - 1 underflows at large K
        with self.assertRaises(g18.NumericalFailure):
            g18._end_terms(np.array([1]), np.array([1e6]), np.array([3]), P)


    def test_parents_must_be_integers(self):
        with self.assertRaises(ValueError):
            data.validate_parents([-1.0, 0.0, 0.5])
        with self.assertRaises(ValueError):
            data.validate_parents([-1, 1, 0])           # parent after child


class FitSelection(unittest.TestCase):
    def test_no_converged_start_gives_an_unresolved_block(self):
        from replytree2024 import g18_fit
        calls = []

        def never(x):                       # an objective that can never be minimized to tolerance in 1 step
            calls.append(1)
            return float(np.sum((np.asarray(x) - 3.0) ** 4)) + 1.0
        out = g18_fit._fit_block(never, ("g0", "f0"), {"g0": (-12, 8), "f0": (-12, 8)},
                                 [("a", {"g0": -5.0, "f0": 5.0})], maxiter=1, fd_step=1e-6)
        self.assertTrue(out["status"].startswith("unresolved"))
        self.assertIsNone(out["values"])
        self.assertEqual(len(out["runs"]), 1)                    # the failed start is kept
        status = g18_fit.fit_status(dict(status="ok"), out, dict(status="ok"))
        self.assertTrue(status.startswith("unresolved"))

    def test_numerical_gate_runs_at_a_fitted_vector(self):
        from replytree2024 import g18_fit
        rng = np.random.default_rng(5)
        trees = [random_tree(rng, int(rng.integers(2, 60)), rng.random()) for _ in range(200)]
        st = data.g18_stats(*data.flatten(trees))
        cd = g18.ContinuationData(st.K, st.C, st.seg_tree, st.seg_a, st.seg_cnt)
        gate = g18_fit.numerical_gate(cd, PARAMS["news_s1729"])
        self.assertTrue(gate["passed"])
        self.assertLess(gate["reference_grid"]["max_abs_per_tree"], 1e-7)


class Generator(unittest.TestCase):
    """The likelihood must describe what the generator actually produces."""

    def test_small_tree_frequencies(self):
        from replytree2024 import g18_sim
        P = PARAMS["mc_check"]
        n = 600_000
        out = g18_sim.simulate_chunk(P, n, np.random.default_rng(20261008), explicit=True)
        off, par = out["offsets"], out["parents"]
        size = np.diff(off)
        # shape -> (parent array, number of distinct child orderings)
        shapes = {
            "one reply": ([-1, 0], 1),
            "chain of 3": ([-1, 0, 1], 1),
            "chain of 4": ([-1, 0, 1, 2], 1),
            "two leaves": ([-1, 0, 0], 1),
            "branch at direct reply": ([-1, 0, 1, 1], 1),
            "leaf and chain": ([-1, 0, 0, 1], 2),
            "branch at later post": ([-1, 0, 1, 2, 2], 1),
        }
        canon = {}
        for name, (t, _) in shapes.items():
            canon[self._canon(t)] = name
        counts = dict.fromkeys(shapes, 0)
        for i in np.flatnonzero(size <= 5):
            key = self._canon(par[off[i]:off[i + 1]].tolist())
            if key in canon:
                counts[canon[key]] += 1
        for name, (t, mult) in shapes.items():
            p = mult * np.exp(g18.tree_log_probability(t, P))
            se = np.sqrt(p * (1 - p) / n)
            self.assertLess(abs(counts[name] / n - p), 4.5 * se + 1e-7,
                            msg=f"{name}: simulated {counts[name] / n:.6f}, likelihood {p:.6f}")

    @staticmethod
    def _canon(parents):
        kids = {}
        for j, p in enumerate(parents):
            kids.setdefault(p, []).append(j)

        def enc(v):
            return "(" + "".join(sorted(enc(c) for c in kids.get(v, []))) + ")"
        return enc(0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
